package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	"ambio.local/archd/internal/runtime"
)

func newCheckoutRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	runWorktreeGit(t, repo, "init", "-b", "main")
	runWorktreeGit(t, repo, "config", "user.email", "ambio-test@example.com")
	runWorktreeGit(t, repo, "config", "user.name", "Ambio Test")
	writeCheckoutFile(t, repo, "api.go", "package sample\n\nfunc Api() {}\n")
	runWorktreeGit(t, repo, "add", ".")
	runWorktreeGit(t, repo, "commit", "-m", "base")
	runWorktreeGit(t, repo, "checkout", "-b", "feature")
	writeCheckoutFile(t, repo, "storage.go", "package sample\n\nfunc Store() {}\n")
	writeCheckoutFile(t, repo, "api.go", "package sample\n\nfunc Api() { Store() }\n")
	runWorktreeGit(t, repo, "add", ".")
	runWorktreeGit(t, repo, "commit", "-m", "feature")
	runWorktreeGit(t, repo, "checkout", "main")
	return repo
}

func writeCheckoutFile(t *testing.T, repo, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func openCheckoutServer(t *testing.T, dataDir, repo string) *Server {
	t.Helper()
	return openCheckoutServerIndexing(t, dataDir, repo, repo)
}

// openCheckoutServerIndexing opens repo and waits until indexed is indexed.
func openCheckoutServerIndexing(t *testing.T, dataDir, repo, indexed string) *Server {
	t.Helper()
	server := NewServer(dataDir, hub.New(), runtime.NewManager(hub.New()))
	server.worktreeRefresh = time.Hour
	payload, err := json.Marshal(openWorkspaceReq{WorkspaceID: "ws", Name: "checkout", RootPath: repo})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.handleWorkspace(response, httptest.NewRequest(http.MethodPost, "/api/workspace", bytes.NewReader(payload)))
	if response.Code != http.StatusOK {
		t.Fatalf("open workspace status = %d, body = %s", response.Code, response.Body.String())
	}
	sqlDB, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	waitForWorktreeTest(t, "the checkout indexed", func() bool {
		roots, err := db.GetActiveRoots(sqlDB, "ws")
		for _, root := range roots {
			if err == nil && sameRootPath(root.Path, indexed) && root.IndexedAt != nil && *root.IndexedAt > 0 {
				return true
			}
		}
		return false
	})
	return server
}

func checkoutAndSettle(t *testing.T, server *Server, repo string, args ...string) {
	t.Helper()
	runWorktreeGit(t, repo, args...)
	head := runWorktreeGit(t, repo, "rev-parse", "HEAD")
	sqlDB, _ := server.dbFor("ws")
	waitForWorktreeTest(t, "the root at "+head, func() bool {
		roots, err := db.GetActiveRoots(sqlDB, "ws")
		return err == nil && len(roots) == 1 && roots[0].HeadCommit == head
	})
	settleCheckout(server)
}

// settleCheckout waits past the watcher's file and classification debounces.
func settleCheckout(server *Server) {
	time.Sleep(2500 * time.Millisecond)
	server.mu.RLock()
	background := server.background["ws"]
	server.mu.RUnlock()
	if background != nil {
		background.Wait()
	}
}

func journalSince(t *testing.T, server *Server, since int64) []db.StructuralEvent {
	t.Helper()
	sqlDB, _ := server.dbFor("ws")
	events, err := db.GetStructuralEvents(sqlDB, "ws", since)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func codeEvents(events []db.StructuralEvent) []db.StructuralEvent {
	var code []db.StructuralEvent
	for _, event := range events {
		if event.Kind != db.EventCheckoutSwitched {
			code = append(code, event)
		}
	}
	return code
}

func TestBranchSwitchRoundTripIsNotJournaledAsCode(t *testing.T) {
	repo := newCheckoutRepo(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	since := time.Now().UnixMilli()

	checkoutAndSettle(t, server, repo, "checkout", "feature")
	sqlDB, _ := server.dbFor("ws")
	snapshot, err := db.GetCanvasSnapshot(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Files) != 2 {
		t.Fatalf("the Floor must follow the switch to feature's two files, got %d", len(snapshot.Files))
	}
	checkoutAndSettle(t, server, repo, "checkout", "main")

	events := journalSince(t, server, since)
	if code := codeEvents(events); len(code) != 0 {
		for _, event := range code {
			t.Errorf("journaled %s %s on %s by %s", event.Kind, event.SubjectLabel, event.Branch, event.Actor)
		}
	}
	switches := map[string]string{}
	for _, event := range events {
		if event.Kind == db.EventCheckoutSwitched {
			switches[event.Branch] = event.SubjectLabel
		}
	}
	if switches["feature"] != "feature" || switches["main"] != "main" {
		t.Fatalf("want one checkout.switched row on each branch, got %#v", switches)
	}

	response := httptest.NewRecorder()
	server.handleDelta(response, httptest.NewRequest(http.MethodGet, "/api/delta?workspace=ws", nil))
	var delta struct {
		Claims []struct {
			Title string `json:"title"`
		} `json:"claims"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &delta); err != nil {
		t.Fatal(err)
	}
	if len(delta.Claims) != 0 {
		t.Fatalf("main is unchanged after the round trip, Review Changes shows %#v", delta.Claims)
	}
}

func TestBranchSwitchedWhileClosedIsNotCaughtUpAsCode(t *testing.T) {
	repo := newCheckoutRepo(t)
	dataDir := t.TempDir()
	first := openCheckoutServer(t, dataDir, repo)
	settleCheckout(first)
	first.closeDB("ws")
	since := time.Now().UnixMilli()

	runWorktreeGit(t, repo, "checkout", "feature")
	second := openCheckoutServer(t, dataDir, repo)
	t.Cleanup(func() { second.closeDB("ws") })
	sqlDB, _ := second.dbFor("ws")
	waitForWorktreeTest(t, "feature's files caught up", func() bool {
		files, err := db.GetCanvasSnapshot(sqlDB, "ws")
		return err == nil && len(files.Files) == 2
	})
	settleCheckout(second)

	if code := codeEvents(journalSince(t, second, since)); len(code) != 0 {
		for _, event := range code {
			t.Errorf("catch-up journaled %s %s on %s by %s", event.Kind, event.SubjectLabel, event.Branch, event.Actor)
		}
	}
}

func TestCodeAroundGitIsStillJournaled(t *testing.T) {
	repo := newCheckoutRepo(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)

	// An agent writes a file and commits it before the watcher's debounce:
	// the file matches the new commit, but a commit writes nothing to disk.
	since := time.Now().UnixMilli()
	writeCheckoutFile(t, repo, "billing.go", "package sample\n\nfunc Bill() {}\n")
	runWorktreeGit(t, repo, "add", "billing.go")
	checkoutAndSettle(t, server, repo, "commit", "-m", "billing")
	if !hasEvent(journalSince(t, server, since), db.EventFileCreated, "billing.go", "main", "human") {
		t.Fatal("a file committed right after it was written must still be journaled as written")
	}

	// An uncommitted edit carried across a switch is still somebody's edit,
	// and belongs to the branch it is now on.
	since = time.Now().UnixMilli()
	writeCheckoutFile(t, repo, "billing.go", "package sample\n\nfunc Bill() { Api() }\n")
	checkoutAndSettle(t, server, repo, "checkout", "-b", "carry")
	events := journalSince(t, server, since)
	if !hasEvent(events, db.EventFileUpdated, "billing.go", "main", "human") &&
		!hasEvent(events, db.EventFileUpdated, "billing.go", "carry", "human") {
		t.Fatalf("the carried edit was not journaled: %#v", events)
	}

	// A reset rewrites files: reviewable, but Git's doing.
	runWorktreeGit(t, repo, "checkout", "--", "billing.go")
	settleCheckout(server)
	since = time.Now().UnixMilli()
	checkoutAndSettle(t, server, repo, "reset", "--hard", "HEAD~1")
	if !hasEvent(journalSince(t, server, since), db.EventFileDeleted, "billing.go", "carry", "git") {
		t.Fatalf("reset should journal billing.go's removal as git: %#v", journalSince(t, server, since))
	}
}

func hasEvent(events []db.StructuralEvent, kind, subject, branch, actor string) bool {
	for _, event := range events {
		if event.Kind == kind && event.SubjectLabel == subject && event.Branch == branch && event.Actor == actor {
			return true
		}
	}
	return false
}

func newMonorepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	for _, file := range []string{"packages/web/web.go", "packages/api/api.go"} {
		path := filepath.Join(repo, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		writeCheckoutFile(t, filepath.Dir(path), filepath.Base(path), "package p\n\nfunc F() {}\n")
	}
	runWorktreeGit(t, repo, "init", "-b", "main")
	runWorktreeGit(t, repo, "config", "user.email", "ambio-test@example.com")
	runWorktreeGit(t, repo, "config", "user.name", "Ambio Test")
	runWorktreeGit(t, repo, "add", ".")
	runWorktreeGit(t, repo, "commit", "-m", "base")
	return repo
}

// A package opened before subfolders were honoured was indexed whole. Moving
// it to the folder would drop every file's system and history, so it stays
// whole until that move is built (WORK git-monorepo-subfolder).
func TestAPackageAlreadyIndexedWholeKeepsItsMap(t *testing.T) {
	repo := newMonorepo(t)
	dataDir := t.TempDir()
	whole := openCheckoutServer(t, dataDir, repo)
	whole.closeDB("ws")

	web := filepath.Join(repo, "packages", "web")
	server := openCheckoutServerIndexing(t, dataDir, web, repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	sqlDB, _ := server.dbFor("ws")
	snapshot, err := db.GetCanvasSnapshot(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Files) != 2 {
		t.Fatalf("the existing whole-repository map lost files: %d left", len(snapshot.Files))
	}
}

func TestOpeningAMonorepoPackageIndexesOnlyThatPackage(t *testing.T) {
	repo := newMonorepo(t)
	agent := filepath.Join(t.TempDir(), "agent")
	runWorktreeGit(t, repo, "worktree", "add", "-b", "agent", agent)
	for _, file := range []string{"packages/web/cart.go", "packages/api/billing.go"} {
		path := filepath.Join(agent, filepath.FromSlash(file))
		writeCheckoutFile(t, filepath.Dir(path), filepath.Base(path), "package p\n\nfunc G() {}\n")
	}

	web := filepath.Join(repo, "packages", "web")
	server := openCheckoutServer(t, t.TempDir(), web)
	t.Cleanup(func() { server.closeDB("ws") })
	sqlDB, _ := server.dbFor("ws")
	snapshot, err := db.GetCanvasSnapshot(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Files) != 1 || snapshot.Files[0].RelPath != "web.go" {
		var paths []string
		for _, file := range snapshot.Files {
			paths = append(paths, file.RelPath)
		}
		t.Fatalf("opening packages/web indexed %v, want only web.go", paths)
	}
	roots, err := db.GetActiveRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range roots {
		if filepath.Base(root.Path) != "web" {
			t.Fatalf("root %s does not point at each checkout's packages/web", root.Path)
		}
	}

	response := httptest.NewRecorder()
	server.handleCollisions(response, httptest.NewRequest(http.MethodGet, "/api/collisions?workspace=ws", nil))
	var collisions struct {
		Branches []struct {
			Branch            string   `json:"branch"`
			UnclassifiedFiles []string `json:"unclassifiedFiles"`
		} `json:"branches"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &collisions); err != nil {
		t.Fatal(err)
	}
	for _, branch := range collisions.Branches {
		if branch.Branch == "agent" {
			if len(branch.UnclassifiedFiles) != 1 || branch.UnclassifiedFiles[0] != "cart.go" {
				t.Fatalf("the agent's changes inside packages/web = %v, want [cart.go]", branch.UnclassifiedFiles)
			}
			return
		}
	}
	t.Fatalf("no agent branch in %s", response.Body.String())
}

func TestGitInitInAnOpenFolderStartsBranchTracking(t *testing.T) {
	folder := t.TempDir()
	writeCheckoutFile(t, folder, "main.go", "package main\n\nfunc main() {}\n")
	server := openCheckoutServer(t, t.TempDir(), folder)
	t.Cleanup(func() { server.closeDB("ws") })
	sqlDB, _ := server.dbFor("ws")
	branchIs := func(branch string) func() bool {
		return func() bool {
			roots, err := db.GetActiveRoots(sqlDB, "ws")
			return err == nil && len(roots) == 1 && roots[0].Branch == branch
		}
	}

	// worktreeRefresh is an hour here: only noticing .git can find these.
	runWorktreeGit(t, folder, "init", "-b", "main")
	waitForWorktreeTest(t, "the new repository's branch", branchIs("main"))
	runWorktreeGit(t, folder, "checkout", "-b", "first-feature")
	waitForWorktreeTest(t, "a branch switch after git init", branchIs("first-feature"))
}
