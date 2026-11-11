package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func changedFiles(t *testing.T, server *Server) map[string]map[string]any {
	t.Helper()
	listed := getJSON(t, server.handleCheckoutChanges, "/api/checkouts/changes?workspace=ws")
	files := map[string]map[string]any{}
	for _, item := range listed["files"].([]any) {
		file := item.(map[string]any)
		files[file["path"].(string)] = file
	}
	return files
}

func TestChangesAreStagedUnstagedDiscardedAndCommittedFromTheMenu(t *testing.T) {
	repo := newCheckoutRepo(t)
	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)

	writeCheckoutFile(t, repo, "api.go", "package sample\n\nfunc Api() { /* edited */ }\n")
	writeCheckoutFile(t, repo, "notes.md", "draft\n")
	writeCheckoutFile(t, repo, "scratch.txt", "throwaway\n")
	files := changedFiles(t, server)
	if files["api.go"]["unstaged"] != "M" || files["notes.md"]["untracked"] != true || len(files) != 3 {
		t.Fatalf("changes = %#v", files)
	}

	// Only what is listed can be touched, and nothing outside the folder.
	postRun(t, server.handleStageChanges, "/api/checkouts/stage", map[string]any{"workspaceId": "ws", "paths": []string{"../escape"}, "stage": true}, 400)
	postRun(t, server.handleStageChanges, "/api/checkouts/stage", map[string]any{"workspaceId": "ws", "paths": []string{"storage.go"}, "stage": true}, 409)

	postRun(t, server.handleStageChanges, "/api/checkouts/stage", map[string]any{"workspaceId": "ws", "paths": []string{"api.go", "notes.md"}, "stage": true}, 200)
	files = changedFiles(t, server)
	if files["api.go"]["staged"] != "M" || files["notes.md"]["staged"] != "A" {
		t.Fatalf("after staging = %#v", files)
	}
	postRun(t, server.handleStageChanges, "/api/checkouts/stage", map[string]any{"workspaceId": "ws", "paths": []string{"notes.md"}, "stage": false}, 200)
	if files = changedFiles(t, server); files["notes.md"]["untracked"] != true {
		t.Fatalf("after unstaging = %#v", files)
	}

	// Discarding an untracked file deletes it; staged work is kept.
	postRun(t, server.handleDiscardChanges, "/api/checkouts/discard", map[string]any{"workspaceId": "ws", "paths": []string{"scratch.txt"}}, 200)
	if _, err := os.Stat(filepath.Join(repo, "scratch.txt")); !os.IsNotExist(err) {
		t.Fatalf("scratch.txt still exists: %v", err)
	}

	postRun(t, server.handleCommit, "/api/checkouts/commit", map[string]any{"workspaceId": "ws", "message": "  "}, 400)
	committed := postRun(t, server.handleCommit, "/api/checkouts/commit", map[string]any{"workspaceId": "ws", "message": "Edit the API"}, 200)
	if committed["files"] != float64(1) || committed["commit"] == "" {
		t.Fatalf("commit = %#v", committed)
	}
	subject := strings.TrimSpace(runWorktreeGit(t, repo, "log", "-1", "--format=%s"))
	if subject != "Edit the API" {
		t.Fatalf("subject = %q", subject)
	}
	// notes.md was not staged, so it is still waiting.
	if files = changedFiles(t, server); len(files) != 1 || files["notes.md"] == nil {
		t.Fatalf("after commit = %#v", files)
	}

	// Nothing staged: refused unless everything is committed.
	postRun(t, server.handleCommit, "/api/checkouts/commit", map[string]any{"workspaceId": "ws", "message": "Notes"}, 409)
	postRun(t, server.handleCommit, "/api/checkouts/commit", map[string]any{"workspaceId": "ws", "message": "Notes", "all": true}, 200)
	if files = changedFiles(t, server); len(files) != 0 {
		t.Fatalf("after commit all = %#v", files)
	}
	postRun(t, server.handleCommit, "/api/checkouts/commit", map[string]any{"workspaceId": "ws", "message": "Again", "all": true}, 409)
}
