package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

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
