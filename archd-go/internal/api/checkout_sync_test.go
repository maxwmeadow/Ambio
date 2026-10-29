package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ambio.local/archd/internal/gitworktree"
)

// A remote (a bare repository), the project's checkout tracking it, and a
// teammate's clone that pushes to it.
func newSyncedCheckout(t *testing.T) (remote, repo, teammate string) {
	t.Helper()
	remote = filepath.Join(t.TempDir(), "remote.git")
	runWorktreeGit(t, filepath.Dir(remote), "init", "--bare", "-b", "main", remote)
	repo = newCheckoutRepo(t)
	runWorktreeGit(t, repo, "remote", "add", "origin", remote)
	runWorktreeGit(t, repo, "push", "-u", "origin", "main")
	teammate = filepath.Join(t.TempDir(), "teammate")
	runWorktreeGit(t, filepath.Dir(teammate), "clone", remote, teammate)
	runWorktreeGit(t, teammate, "config", "user.email", "teammate@example.com")
	runWorktreeGit(t, teammate, "config", "user.name", "Teammate")
	return remote, repo, teammate
}

func commitFile(t *testing.T, repo, name, body, message string) {
	t.Helper()
	writeCheckoutFile(t, repo, name, body)
	runWorktreeGit(t, repo, "add", name)
	runWorktreeGit(t, repo, "commit", "-m", message)
}

func syncAction(t *testing.T, server *Server, action string, want int) map[string]any {
	t.Helper()
	return postRun(t, server.handleCheckoutSync, "/api/checkouts/sync", map[string]string{"workspaceId": "ws", "action": action}, want)
}

func focusedStatus(t *testing.T, server *Server) checkoutStatus {
	t.Helper()
	for _, checkout := range getCheckouts(t, server).Checkouts {
		if checkout.IsFocused {
			return checkout
		}
	}
	t.Fatal("no focused checkout")
	return checkoutStatus{}
}

func TestFetchPullAndPushKeepTheCheckoutInStepWithItsRemote(t *testing.T) {
	remote, repo, teammate := newSyncedCheckout(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)

	commitFile(t, teammate, "billing.go", "package sample\n\nfunc Bill() {}\n", "billing")
	runWorktreeGit(t, teammate, "push")

	syncAction(t, server, "fetch", http.StatusOK)
	status := focusedStatus(t, server)
	if status.Behind != 1 || status.Upstream != "origin/main" || status.FetchedAt == 0 || status.PublishRemote != "origin" {
		t.Fatalf("after fetch: behind %d upstream %q fetchedAt %d publish %q", status.Behind, status.Upstream, status.FetchedAt, status.PublishRemote)
	}
	if _, err := os.Stat(filepath.Join(repo, "billing.go")); !os.IsNotExist(err) {
		t.Fatal("fetch changed the checkout's files")
	}

	syncAction(t, server, "pull", http.StatusOK)
	if _, err := os.Stat(filepath.Join(repo, "billing.go")); err != nil {
		t.Fatal("pull did not bring the teammate's file")
	}
	if status := focusedStatus(t, server); status.Behind != 0 {
		t.Fatalf("still %d behind after pull", status.Behind)
	}

	commitFile(t, repo, "storage.go", "package sample\n\nfunc Store() {}\n", "storage")
	syncAction(t, server, "push", http.StatusOK)
	if log := runWorktreeGit(t, remote, "log", "--oneline", "main"); !strings.Contains(log, "storage") {
		t.Fatalf("push did not reach the remote:\n%s", log)
	}

	// A branch without an upstream is published to origin and tracks it.
	runWorktreeGit(t, repo, "switch", "-c", "idea")
	server.resyncWorktrees("ws")
	settleCheckout(server)
	refused := syncAction(t, server, "push", http.StatusConflict)
	if !strings.Contains(refused["error"].(string), "Publish it instead") {
		t.Fatalf("push without upstream = %v", refused)
	}
	syncAction(t, server, "publish", http.StatusOK)
	if upstream := runWorktreeGit(t, repo, "rev-parse", "--abbrev-ref", "idea@{upstream}"); upstream != "origin/idea" {
		t.Fatalf("upstream after publish = %q", upstream)
	}
}

func TestGitsRefusalsAreSaidPlainlyAndNothingIsForced(t *testing.T) {
	remote, repo, teammate := newSyncedCheckout(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)

	// Both sides moved on: pull refuses rather than merging, push refuses
	// rather than forcing.
	commitFile(t, teammate, "api.go", "package sample\n\nfunc Api() { Bill() }\n", "teammate's api")
	runWorktreeGit(t, teammate, "push")
	commitFile(t, repo, "storage.go", "package sample\n\nfunc Store() {}\n", "local storage")
	pull := syncAction(t, server, "pull", http.StatusConflict)
	if !strings.Contains(pull["error"].(string), "have both moved on") {
		t.Fatalf("diverged pull = %v", pull)
	}
	push := syncAction(t, server, "push", http.StatusConflict)
	if !strings.Contains(push["error"].(string), "Pull first") {
		t.Fatalf("rejected push = %v", push)
	}
	if log := runWorktreeGit(t, remote, "log", "--oneline", "main"); strings.Contains(log, "local storage") {
		t.Fatal("a rejected push changed the remote")
	}

	// Local changes in a file the incoming commit changes: pull says so.
	runWorktreeGit(t, repo, "reset", "--hard", "origin/main~1")
	writeCheckoutFile(t, repo, "api.go", "package sample\n\n// mine\nfunc Api() {}\n")
	dirty := syncAction(t, server, "pull", http.StatusConflict)
	if !strings.Contains(dirty["error"].(string), "uncommitted changes") {
		t.Fatalf("pull over local changes = %v", dirty)
	}
	if body, _ := os.ReadFile(filepath.Join(repo, "api.go")); !strings.Contains(string(body), "mine") {
		t.Fatal("pull touched the uncommitted change")
	}

	if bad := postRun(t, server.handleCheckoutSync, "/api/checkouts/sync", map[string]string{"workspaceId": "ws", "action": "reset"}, http.StatusBadRequest); bad["error"] == nil {
		t.Fatal("an unknown action was accepted")
	}
}

func TestABranchWithNoRemoteHasNowhereToPublish(t *testing.T) {
	repo := newCheckoutRepo(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	if status := focusedStatus(t, server); status.PublishRemote != "" || status.FetchedAt != 0 {
		t.Fatalf("no remote: publish %q fetchedAt %d", status.PublishRemote, status.FetchedAt)
	}
	refused := syncAction(t, server, "publish", http.StatusConflict)
	if !strings.Contains(refused["error"].(string), "no remote to publish to") {
		t.Fatalf("publish without a remote = %v", refused)
	}
	pull := syncAction(t, server, "pull", http.StatusConflict)
	if !strings.Contains(pull["error"].(string), "no upstream branch") {
		t.Fatalf("pull without upstream = %v", pull)
	}
}

func TestSignInAndNetworkFailuresAreExplained(t *testing.T) {
	refusal := func(output string) error {
		return &gitworktree.SyncError{Args: []string{"fetch"}, Output: output, Err: errors.New("exit status 128")}
	}
	for output, want := range map[string]string{
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled":            "could not sign in",
		"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.": "could not sign in",
		"fatal: unable to access 'https://example.invalid/': Could not resolve host: example.invalid":   "Could not reach origin/main",
		"remote: error: GH006: Protected branch update failed for refs/heads/main.":                     "refused the push",
	} {
		if got := syncRefusal("push", "main", "origin/main", refusal(output)); !strings.Contains(got, want) {
			t.Errorf("%q -> %q, want it to contain %q", output, got, want)
		}
	}
	if got := syncRefusal("fetch", "main", "", errors.New("something new")); got != "something new" {
		t.Errorf("an unknown refusal keeps Git's words, got %q", got)
	}
	if got := gitworktree.PublishRemote([]string{"upstream", "origin"}); got != "origin" {
		t.Errorf("PublishRemote prefers origin, got %q", got)
	}
	if got := gitworktree.PublishRemote([]string{"a", "b"}); got != "" {
		t.Errorf("PublishRemote with no obvious choice = %q", got)
	}
}

func TestBranchesAreListedCreatedAndDeletedOnlyWhenSafe(t *testing.T) {
	_, repo, _ := newSyncedCheckout(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	commitFile(t, repo, "storage.go", "package sample\n\nfunc Store() {}\n", "add storage")

	listed := getJSON(t, server.handleBranches, "/api/checkouts/branches?workspace=ws")
	first := listed["branches"].([]any)[0].(map[string]any)
	if first["name"] != "main" || first["upstream"] != "origin/main" || first["ahead"] != float64(1) || first["subject"] != "add storage" || first["committedAt"] == nil || first["rootId"] == nil {
		t.Fatalf("main as listed = %#v", first)
	}

	// A new branch starts where the Floor is.
	postRun(t, server.handleSwitchBranch, "/api/checkouts/switch", map[string]any{"workspaceId": "ws", "branch": "idea", "create": true}, http.StatusOK)
	if head := runWorktreeGit(t, repo, "branch", "--show-current"); head != "idea" {
		t.Fatalf("created and switched to %q", head)
	}
	postRun(t, server.handleSwitchBranch, "/api/checkouts/switch", map[string]any{"workspaceId": "ws", "branch": "bad..name", "create": true}, http.StatusBadRequest)
	exists := postRun(t, server.handleSwitchBranch, "/api/checkouts/switch", map[string]any{"workspaceId": "ws", "branch": "main", "create": true}, http.StatusConflict)
	if !strings.Contains(exists["error"].(string), "already exists") {
		t.Fatalf("creating an existing branch = %v", exists)
	}

	// The Floor's own branch is never deleted; one with commits found
	// nowhere else is refused; a merged one goes.
	server.resyncWorktrees("ws")
	settleCheckout(server)
	current := postRun(t, server.handleDeleteBranch, "/api/checkouts/branches/delete", map[string]string{"workspaceId": "ws", "branch": "idea"}, http.StatusConflict)
	if !strings.Contains(current["error"].(string), "checked out") {
		t.Fatalf("deleting the Floor's branch = %v", current)
	}
	commitFile(t, repo, "spike.go", "package sample\n", "spike")
	runWorktreeGit(t, repo, "switch", "main")
	server.resyncWorktrees("ws")
	settleCheckout(server)
	unmerged := postRun(t, server.handleDeleteBranch, "/api/checkouts/branches/delete", map[string]string{"workspaceId": "ws", "branch": "idea"}, http.StatusConflict)
	if !strings.Contains(unmerged["error"].(string), "would lose them") {
		t.Fatalf("deleting an unmerged branch = %v", unmerged)
	}
	runWorktreeGit(t, repo, "branch", "done")
	postRun(t, server.handleDeleteBranch, "/api/checkouts/branches/delete", map[string]string{"workspaceId": "ws", "branch": "done"}, http.StatusOK)
	if branches := runWorktreeGit(t, repo, "branch", "--list", "done", "idea"); strings.Contains(branches, "done") || !strings.Contains(branches, "idea") {
		t.Fatalf("branches after delete:\n%s", branches)
	}
}

func getJSON(t *testing.T, handler http.HandlerFunc, path string) map[string]any {
	t.Helper()
	response := httptest.NewRecorder()
	handler(response, httptest.NewRequest(http.MethodGet, path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("%s status = %d, body = %s", path, response.Code, response.Body.String())
	}
	result := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
