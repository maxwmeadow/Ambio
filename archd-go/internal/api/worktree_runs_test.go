package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func postRun(t *testing.T, handler http.HandlerFunc, path string, body map[string]string, want int) map[string]any {
	t.Helper()
	payload, _ := json.Marshal(body)
	response := httptest.NewRecorder()
	handler(response, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(payload)))
	if response.Code != want {
		t.Fatalf("%s status = %d, want %d, body = %s", path, response.Code, want, response.Body.String())
	}
	result := map[string]any{}
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	return result
}

func TestAWorktreeRunIsAppliedAsUncommittedWorkOrDiscarded(t *testing.T) {
	repo := newCheckoutRepo(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)

	created := postRun(t, server.handleCreateRunWorktree, "/api/checkouts/worktree", map[string]string{"workspaceId": "ws", "name": "Add billing!"}, http.StatusOK)
	path, branch := created["path"].(string), created["branch"].(string)
	if !strings.HasPrefix(branch, "ambio/add-billing-") {
		t.Fatalf("branch = %q", branch)
	}
	if inside, err := filepath.Rel(server.worktreesRoot(), path); err != nil || strings.HasPrefix(inside, "..") {
		t.Fatalf("worktree %s is not under %s", path, server.worktreesRoot())
	}
	// The agent works without committing, as agents do.
	writeCheckoutFile(t, path, "billing.go", "package sample\n\nfunc Bill() {}\n")
	writeCheckoutFile(t, path, "api.go", "package sample\n\nfunc Api() { Bill() }\n")

	applied := postRun(t, server.handleFinishRunWorktree, "/api/checkouts/finish", map[string]string{"workspaceId": "ws", "rootId": created["rootId"].(string), "action": "apply"}, http.StatusOK)
	if applied["into"] != "main" || applied["conflicted"] != nil {
		t.Fatalf("apply = %#v", applied)
	}
	if body, _ := os.ReadFile(filepath.Join(repo, "billing.go")); !strings.Contains(string(body), "Bill") {
		t.Fatal("the run's new file is not in main's checkout")
	}
	if status := runWorktreeGit(t, repo, "status", "--porcelain"); !strings.Contains(status, "api.go") || !strings.Contains(status, "billing.go") {
		t.Fatalf("the run's work must arrive uncommitted, status:\n%s", status)
	}
	if log := runWorktreeGit(t, repo, "log", "--oneline"); strings.Count(log, "\n") != 0 {
		t.Fatalf("Ambio committed something:\n%s", log)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the applied run's worktree is still there")
	}
	if branches := runWorktreeGit(t, repo, "branch", "--list", branch); branches != "" {
		t.Fatalf("the applied run's branch is still there: %s", branches)
	}

	// Switching with uncommitted work is refused, and says why.
	refused := httptest.NewRecorder()
	payload, _ := json.Marshal(map[string]string{"workspaceId": "ws", "branch": "feature"})
	server.handleSwitchBranch(refused, httptest.NewRequest(http.MethodPost, "/api/checkouts/switch", bytes.NewReader(payload)))
	if refused.Code != http.StatusConflict || !strings.Contains(refused.Body.String(), "uncommitted") {
		t.Fatalf("switch while dirty = %d %s", refused.Code, refused.Body.String())
	}
	runWorktreeGit(t, repo, "checkout", "--", ".")
	runWorktreeGit(t, repo, "clean", "-fdq")

	second := postRun(t, server.handleCreateRunWorktree, "/api/checkouts/worktree", map[string]string{"workspaceId": "ws", "name": "spike"}, http.StatusOK)
	writeCheckoutFile(t, second["path"].(string), "spike.go", "package sample\n")
	postRun(t, server.handleFinishRunWorktree, "/api/checkouts/finish", map[string]string{"workspaceId": "ws", "rootId": second["rootId"].(string), "action": "discard"}, http.StatusOK)
	if _, err := os.Stat(filepath.Join(repo, "spike.go")); !os.IsNotExist(err) {
		t.Fatal("a discarded run's work reached main")
	}
	if _, err := os.Stat(second["path"].(string)); !os.IsNotExist(err) {
		t.Fatal("the discarded run's worktree is still there")
	}

	// Ambio finishes only its own worktrees.
	other := filepath.Join(t.TempDir(), "mine")
	runWorktreeGit(t, repo, "worktree", "add", "-b", "mine", other)
	server.resyncWorktrees("ws")
	sqlDB, _ := server.dbFor("ws")
	root, ok := waitForRoot(sqlDB, "ws", other, true, "")
	if !ok {
		t.Fatal("the user's worktree was not registered")
	}
	postRun(t, server.handleFinishRunWorktree, "/api/checkouts/finish", map[string]string{"workspaceId": "ws", "rootId": root.ID, "action": "discard"}, http.StatusForbidden)

	// A branch open in another worktree points to Show on the Floor.
	conflict := httptest.NewRecorder()
	payload, _ = json.Marshal(map[string]string{"workspaceId": "ws", "branch": "mine"})
	server.handleSwitchBranch(conflict, httptest.NewRequest(http.MethodPost, "/api/checkouts/switch", bytes.NewReader(payload)))
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "Show on the Floor") {
		t.Fatalf("switch to a branch open elsewhere = %d %s", conflict.Code, conflict.Body.String())
	}
	postRun(t, server.handleSwitchBranch, "/api/checkouts/switch", map[string]string{"workspaceId": "ws", "branch": "feature"}, http.StatusOK)
	if head := runWorktreeGit(t, repo, "branch", "--show-current"); head != "feature" {
		t.Fatalf("switched to %q", head)
	}
}
