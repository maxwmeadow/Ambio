package api

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// A package opened before subfolders were honoured was indexed whole. On the
// next open its map moves onto the package: the package's files keep their
// identity, systems and history; the rest of the repository leaves quietly.
func TestAPackageIndexedWholeMovesOntoItsFolder(t *testing.T) {
	repo := newMonorepo(t)
	dataDir := t.TempDir()
	whole := openCheckoutServer(t, dataDir, repo)
	settleCheckout(whole)
	wholeDB, _ := whole.dbFor("ws")
	var webID string
	if err := wholeDB.QueryRow(`SELECT id FROM files WHERE rel_path = 'packages/web/web.go'`).Scan(&webID); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertSystem(wholeDB, db.System{ID: "sys_storefront", WorkspaceID: "ws", Name: "Storefront", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	if _, err := wholeDB.Exec(`UPDATE files SET system_id = 'sys_storefront' WHERE id = ?`, webID); err != nil {
		t.Fatal(err)
	}
	whole.closeDB("ws")
	since := time.Now().UnixMilli()

	web := filepath.Join(repo, "packages", "web")
	server := openCheckoutServerIndexing(t, dataDir, web, web)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	sqlDB, _ := server.dbFor("ws")
	snapshot, err := db.GetCanvasSnapshot(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("the package's map holds %d files, want only web.go", len(snapshot.Files))
	}
	file := snapshot.Files[0]
	if file.ID != webID || file.RelPath != "web.go" || file.SystemID == nil || *file.SystemID != "sys_storefront" {
		t.Fatalf("web.go lost its identity or system moving onto the package: %#v", file)
	}
	if code := codeEvents(journalSince(t, server, since)); len(code) != 0 {
		for _, event := range code {
			t.Errorf("moving the map journaled %s %s", event.Kind, event.SubjectLabel)
		}
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

func TestABranchSwitchInsideOneOfSeveralRepositoriesIsNotCode(t *testing.T) {
	parent := t.TempDir()
	web := filepath.Join(parent, "web")
	api := filepath.Join(parent, "api")
	for _, repo := range []string{web, api} {
		if err := os.MkdirAll(repo, 0o755); err != nil {
			t.Fatal(err)
		}
		runWorktreeGit(t, repo, "init", "-b", "main")
		runWorktreeGit(t, repo, "config", "user.email", "ambio-test@example.com")
		runWorktreeGit(t, repo, "config", "user.name", "Ambio Test")
		writeCheckoutFile(t, repo, "main.go", "package app\n\nfunc Run() {}\n")
		runWorktreeGit(t, repo, "add", ".")
		runWorktreeGit(t, repo, "commit", "-m", "base")
	}
	runWorktreeGit(t, web, "checkout", "-b", "feature")
	writeCheckoutFile(t, web, "cart.go", "package app\n\nfunc Cart() { Run() }\n")
	runWorktreeGit(t, web, "add", ".")
	runWorktreeGit(t, web, "commit", "-m", "cart")
	runWorktreeGit(t, web, "checkout", "main")

	server := openCheckoutServer(t, t.TempDir(), parent)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	since := time.Now().UnixMilli()
	runWorktreeGit(t, web, "checkout", "feature")
	sqlDB, _ := server.dbFor("ws")
	waitForWorktreeTest(t, "web/cart.go on the map", func() bool {
		snapshot, err := db.GetCanvasSnapshot(sqlDB, "ws")
		if err != nil {
			return false
		}
		for _, file := range snapshot.Files {
			if file.RelPath == "web/cart.go" {
				return true
			}
		}
		return false
	})
	settleCheckout(server)
	events := journalSince(t, server, since)
	if code := codeEvents(events); len(code) != 0 {
		for _, event := range code {
			t.Errorf("journaled %s %s by %s", event.Kind, event.SubjectLabel, event.Actor)
		}
	}
	if !hasEvent(events, db.EventCheckoutSwitched, "web: feature", "", "git") {
		t.Fatalf("want one switch row naming the repository: %#v", events)
	}
}

// A branch switch large enough to be indexed as one batch, which also
// changes how a file it did not touch resolves its calls: caller.go's
// Render() was ambiguous and becomes unique when the switch removes one of
// the two definitions. Neither the files Git wrote nor that new edge are
// anybody's code; only the switch row is journaled.
func TestALargeBranchSwitchJournalsNoCodeEvenWhereResolutionShifts(t *testing.T) {
	repo := t.TempDir()
	runWorktreeGit(t, repo, "init", "-b", "main")
	runWorktreeGit(t, repo, "config", "user.email", "ambio-test@example.com")
	runWorktreeGit(t, repo, "config", "user.name", "Ambio Test")
	writeCheckoutFile(t, repo, "left.go", "package sample\n\nfunc Render() int { return 1 }\n")
	writeCheckoutFile(t, repo, "right.go", "package sample\n\nfunc Render() int { return 2 }\n")
	writeCheckoutFile(t, repo, "caller.go", "package sample\n\nfunc Show() int { return Render() }\n")
	for index := 0; index < 10; index++ {
		writeCheckoutFile(t, repo, fmt.Sprintf("part%d.go", index), fmt.Sprintf("package sample\n\nfunc Part%d() int { return %d }\n", index, index))
	}
	runWorktreeGit(t, repo, "add", ".")
	runWorktreeGit(t, repo, "commit", "-m", "base")
	runWorktreeGit(t, repo, "checkout", "-b", "trim")
	runWorktreeGit(t, repo, "rm", "-q", "right.go")
	for index := 0; index < 10; index++ {
		writeCheckoutFile(t, repo, fmt.Sprintf("part%d.go", index), fmt.Sprintf("package sample\n\nfunc Part%d() int { return %d + Show() }\n", index, index))
	}
	runWorktreeGit(t, repo, "add", ".")
	runWorktreeGit(t, repo, "commit", "-m", "trim")
	runWorktreeGit(t, repo, "checkout", "main")

	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	since := time.Now().UnixMilli()
	runWorktreeGit(t, repo, "checkout", "trim")
	sqlDB, _ := server.dbFor("ws")
	focused, _, err := server.focusedRoot(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	waitForWorktreeTest(t, "right.go off the map", func() bool {
		file, err := db.GetFileByRelPath(sqlDB, focused.ID, "right.go")
		return err == nil && file == nil
	})
	settleCheckout(server)
	events := journalSince(t, server, since)
	for _, event := range codeEvents(events) {
		t.Errorf("journaled %s %s -> %s by %s", event.Kind, event.SubjectLabel, event.ObjectLabel, event.Actor)
	}
	if !hasEvent(events, db.EventCheckoutSwitched, "trim", "trim", "git") {
		t.Fatalf("want the switch row: %#v", events)
	}
}

// Reading Review Changes while a sync reshapes the map (the Floor moving to
// another checkout) compared a half-moved map with the last review and
// showed hundreds of changes by you, and saved that half map as a snapshot
// for every later comparison. While a root syncs, no snapshot is taken.
func TestDeltaTakesNoSnapshotWhileTheMapSyncs(t *testing.T) {
	repo := newCheckoutRepo(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	sqlDB, _ := server.dbFor("ws")
	focused, _, err := server.focusedRoot(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	snapshots := func() int {
		var count int
		if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM root_delta_snapshots`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	read := func() {
		response := httptest.NewRecorder()
		server.handleDelta(response, httptest.NewRequest(http.MethodGet, "/api/delta?workspace=ws", nil))
		if response.Code != http.StatusOK {
			t.Fatalf("delta = %d %s", response.Code, response.Body.String())
		}
	}
	before := snapshots()
	server.mu.Lock()
	server.rootSyncing[focused.ID] = true
	server.mu.Unlock()
	read()
	if snapshots() != before {
		t.Fatal("a delta read during a sync saved a snapshot of the half-synced map")
	}
	server.mu.Lock()
	delete(server.rootSyncing, focused.ID)
	server.mu.Unlock()
	time.Sleep(5 * time.Millisecond) // a snapshot is keyed by the millisecond
	read()
	if snapshots() == before {
		t.Fatal("a delta read once the map settled takes a snapshot again")
	}
}
