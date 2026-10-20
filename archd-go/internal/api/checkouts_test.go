package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"ambio.local/archd/internal/db"
)

func getCheckouts(t *testing.T, server *Server) checkoutsSnapshot {
	t.Helper()
	response := httptest.NewRecorder()
	server.handleCheckouts(response, httptest.NewRequest(http.MethodGet, "/api/checkouts?workspace=ws", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("checkouts status = %d, body = %s", response.Code, response.Body.String())
	}
	var snapshot checkoutsSnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestCheckoutsDescribeEveryWorkingCopy(t *testing.T) {
	repo := newCheckoutRepo(t)
	agent := filepath.Join(t.TempDir(), "agent")
	runWorktreeGit(t, repo, "worktree", "add", "-b", "agent", agent)
	writeCheckoutFile(t, agent, "billing.go", "package sample\n\nfunc Bill() {}\n")
	writeCheckoutFile(t, agent, "api.go", "package sample\n\nfunc Api() { Bill() }\n")

	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	snapshot := getCheckouts(t, server)
	if snapshot.VCS != "git" || len(snapshot.Checkouts) != 2 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	focused, linked := snapshot.Checkouts[0], snapshot.Checkouts[1]
	if !focused.IsFocused || focused.Branch != "main" || focused.HeadState != headCommit || focused.ChangedFiles != 0 {
		t.Fatalf("the Floor's checkout comes first and is clean: %#v", focused)
	}
	if linked.IsFocused || linked.Branch != "agent" || linked.ChangedFiles != 2 || linked.Error != "" {
		t.Fatalf("the agent's worktree: %#v", linked)
	}
}

func TestCheckoutsWordPlainAndNewRepositories(t *testing.T) {
	folder := t.TempDir()
	writeCheckoutFile(t, folder, "main.go", "package main\n")
	server := openCheckoutServer(t, t.TempDir(), folder)
	t.Cleanup(func() { server.closeDB("ws") })
	if snapshot := getCheckouts(t, server); snapshot.VCS != "none" || snapshot.Checkouts[0].HeadState != headNone {
		t.Fatalf("a plain folder = %#v", snapshot)
	}

	runWorktreeGit(t, folder, "init", "-b", "main")
	waitForWorktreeTest(t, "the new repository", func() bool {
		snapshot := getCheckouts(t, server)
		return snapshot.VCS == "git" && snapshot.Checkouts[0].HeadState == headUnborn && snapshot.Checkouts[0].ChangedFiles == 1
	})
}

func TestAnotherCheckoutsChangesBecomeItsOverlay(t *testing.T) {
	repo := newCheckoutRepo(t)
	runWorktreeGit(t, repo, "checkout", "feature")
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })

	agent := filepath.Join(t.TempDir(), "agent")
	runWorktreeGit(t, repo, "worktree", "add", "-b", "agent", agent, "feature")
	writeCheckoutFile(t, agent, "api.go", "package sample\n\nfunc Api() { Store(); Bill() }\n")
	writeCheckoutFile(t, agent, "billing.go", "package sample\n\nfunc Bill() {}\n")
	writeCheckoutFile(t, agent, "logo.png", "not source\n")
	runWorktreeGit(t, agent, "rm", "-q", "storage.go")

	sqlDB, _ := server.dbFor("ws")
	floor := map[string]string{}
	files, _ := db.GetFilesByRoot(sqlDB, server.focusedRootID(t))
	for _, file := range files {
		floor[file.RelPath] = file.ID
	}
	var linked checkoutStatus
	defer func() {
		if t.Failed() {
			t.Logf("last snapshot: %#v", getCheckouts(t, server))
		}
	}()
	waitForWorktreeTest(t, "the agent's overlay", func() bool {
		server.invalidateCollisionCache("ws")
		for _, checkout := range getCheckouts(t, server).Checkouts {
			if checkout.Branch == "agent" {
				linked = checkout
				return len(checkout.Overlay) == 3
			}
		}
		return false
	})
	got := map[string]overlayFile{}
	for _, file := range linked.Overlay {
		got[file.Path] = file
	}
	if got["api.go"].Change != overlayModified || got["api.go"].FileID != floor["api.go"] {
		t.Errorf("api.go = %#v", got["api.go"])
	}
	if got["storage.go"].Change != overlayDeleted || got["storage.go"].FileID != floor["storage.go"] {
		t.Errorf("storage.go = %#v", got["storage.go"])
	}
	if got["billing.go"].Change != overlayAdded || got["billing.go"].FileID != "" {
		t.Errorf("billing.go = %#v", got["billing.go"])
	}
	for _, checkout := range getCheckouts(t, server).Checkouts {
		if checkout.IsFocused && len(checkout.Overlay) != 0 {
			t.Fatalf("the Floor's own checkout has no overlay: %#v", checkout.Overlay)
		}
	}
}

func TestANewFileBelongsToTheSystemOwningItsFolder(t *testing.T) {
	payments, orders := "payments", "orders"
	folders := newFolderSystems([]db.File{
		{RelPath: "src/payments/stripe.go", SystemID: &payments},
		{RelPath: "src/payments/refunds.go", SystemID: &payments},
		{RelPath: "src/payments/cart.go", SystemID: &orders},
		{RelPath: "src/orders/cart.go", SystemID: &orders},
	})
	for path, want := range map[string]string{
		"src/payments/retry.go": payments,
		"src/orders/sub/new.go": orders,
		"src/unknown/x.go":      "",
		"elsewhere.go":          "",
	} {
		if got := folders.owner(path); got != want {
			t.Errorf("owner(%s) = %q, want %q", path, got, want)
		}
	}
}

func (s *Server) focusedRootID(t *testing.T) string {
	t.Helper()
	s.mu.RLock()
	defer s.mu.RUnlock()
	for rootID := range s.watchers {
		return rootID
	}
	t.Fatal("no checkout is on the Floor")
	return ""
}

func focusCheckout(t *testing.T, server *Server, rootID string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"workspaceId": "ws", "rootId": rootID})
	response := httptest.NewRecorder()
	server.handleCheckoutFocus(response, httptest.NewRequest(http.MethodPost, "/api/checkouts/focus", bytes.NewReader(payload)))
	if response.Code != http.StatusOK {
		t.Fatalf("focus status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestShowingAnotherCheckoutKeepsTheMapAndJournalsNothing(t *testing.T) {
	repo := newCheckoutRepo(t)
	agent := filepath.Join(t.TempDir(), "agent")
	runWorktreeGit(t, repo, "worktree", "add", "-b", "agent", agent, "feature")
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	sqlDB, _ := server.dbFor("ws")
	mainRoot := server.focusedRootID(t)
	before, _ := db.GetFilesByRoot(sqlDB, mainRoot)
	if len(before) != 1 {
		t.Fatalf("main's Floor = %d files", len(before))
	}
	apiID := before[0].ID
	since := time.Now().UnixMilli()

	agentRoot := ""
	for _, checkout := range getCheckouts(t, server).Checkouts {
		if checkout.Branch == "agent" {
			agentRoot = checkout.RootID
		}
	}
	focusCheckout(t, server, agentRoot)
	waitForWorktreeTest(t, "the Floor on the agent's checkout", func() bool {
		files, err := db.GetFilesByRoot(sqlDB, agentRoot)
		return err == nil && len(files) == 2
	})
	settleCheckout(server)
	files, _ := db.GetFilesByRoot(sqlDB, agentRoot)
	kept := false
	for _, file := range files {
		if file.RelPath == "api.go" && file.ID == apiID {
			kept = true
		}
	}
	if !kept {
		t.Fatalf("api.go lost its identity moving to the agent's checkout: %#v", files)
	}
	if left, _ := db.GetFilesByRoot(sqlDB, mainRoot); len(left) != 0 {
		t.Fatalf("main still holds %d file rows", len(left))
	}
	server.invalidateCollisionCache("ws")
	snapshot := getCheckouts(t, server)
	if snapshot.Checkouts[0].RootID != agentRoot || !snapshot.Checkouts[0].IsFocused {
		t.Fatalf("the chip must follow the Floor: %#v", snapshot.Checkouts[0])
	}
	// main is an ancestor of the agent's branch: against their merge base it
	// changes nothing, so it draws nothing. Overlays show what a branch did.
	if main := snapshot.Checkouts[1]; len(main.Overlay) != 0 {
		t.Fatalf("main's own changes since the merge base = %#v", main.Overlay)
	}

	focusCheckout(t, server, mainRoot)
	waitForWorktreeTest(t, "the Floor back on main", func() bool {
		files, err := db.GetFilesByRoot(sqlDB, mainRoot)
		return err == nil && len(files) == 1 && files[0].ID == apiID
	})
	settleCheckout(server)
	if code := codeEvents(journalSince(t, server, since)); len(code) != 0 {
		for _, event := range code {
			t.Errorf("showing a checkout journaled %s %s on %s", event.Kind, event.SubjectLabel, event.Branch)
		}
	}
}

func TestAFolderOfRepositoriesListsEachOne(t *testing.T) {
	parent := t.TempDir()
	for _, folder := range []string{"web", "services/api"} {
		repo := filepath.Join(parent, filepath.FromSlash(folder))
		writeRepoFile(t, repo, "main.go", "package app\n")
		runWorktreeGit(t, repo, "init", "-b", "main")
		runWorktreeGit(t, repo, "config", "user.email", "ambio-test@example.com")
		runWorktreeGit(t, repo, "config", "user.name", "Ambio Test")
		runWorktreeGit(t, repo, "add", ".")
		runWorktreeGit(t, repo, "commit", "-m", "base")
	}
	runWorktreeGit(t, filepath.Join(parent, "web"), "checkout", "-b", "redesign")
	writeRepoFile(t, filepath.Join(parent, "web"), "draft.go", "package app\n")

	server := openCheckoutServer(t, t.TempDir(), parent)
	t.Cleanup(func() { server.closeDB("ws") })
	snapshot := getCheckouts(t, server)
	if snapshot.VCS != "repos" || len(snapshot.Repositories) != 2 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	byFolder := map[string]repositoryStatus{}
	for _, repository := range snapshot.Repositories {
		byFolder[repository.Folder] = repository
	}
	if web := byFolder["web"]; web.Branch != "redesign" || web.ChangedFiles != 1 || web.HeadState != headCommit {
		t.Fatalf("web = %#v", web)
	}
	if api := byFolder["services/api"]; api.Branch != "main" || api.ChangedFiles != 0 {
		t.Fatalf("services/api = %#v", api)
	}
}
