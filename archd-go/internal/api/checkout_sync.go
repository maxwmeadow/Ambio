package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"ambio.local/archd/internal/gitworktree"
)

// POST /api/checkouts/sync {workspaceId, action: "fetch"|"pull"|"push"|"publish"}
//
// Talks to the Floor's checkout's remote when the person asks
// (docs/GIT_WORKFLOW.md stage 1). Pull is fast-forward only and push is never
// forced; when Git refuses, the reply says why in plain words. One of these
// runs per project at a time. A pull moves HEAD, which the worktree monitor
// journals as one "Pulled N commits" entry like a pull made anywhere else.
func (s *Server) handleCheckoutSync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Action      string `json:"action"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	switch body.Action {
	case "fetch", "pull", "push", "publish":
	default:
		jsonError(w, `action must be "fetch", "pull", "push" or "publish"`, http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	focused, _, err := s.focusedRoot(sqlDB, body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}
	if !s.beginSync(body.WorkspaceID) {
		jsonError(w, "Ambio is already talking to this project's remote. Try again when it finishes.", http.StatusConflict)
		return
	}
	defer s.endSync(body.WorkspaceID)

	status, err := gitworktree.ReadStatus(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	branch := focused.Branch
	if branch == "" || branch == gitworktree.DetachedBranch {
		if body.Action != "fetch" {
			jsonError(w, "This checkout is not on a branch. Switch to a branch first.", http.StatusConflict)
			return
		}
	}
	ctx := r.Context()
	switch body.Action {
	case "fetch":
		err = gitworktree.Fetch(ctx, focused.Path)
	case "pull":
		if status.Upstream == "" {
			jsonError(w, fmt.Sprintf("%s has no upstream branch to pull from. Publish it first.", branch), http.StatusConflict)
			return
		}
		err = gitworktree.Pull(ctx, focused.Path)
	case "push":
		if status.Upstream == "" {
			jsonError(w, fmt.Sprintf("%s has no upstream branch yet. Publish it instead.", branch), http.StatusConflict)
			return
		}
		err = gitworktree.Push(ctx, focused.Path)
	case "publish":
		if status.Upstream != "" {
			jsonError(w, fmt.Sprintf("%s already tracks %s. Push instead.", branch, status.Upstream), http.StatusConflict)
			return
		}
		remotes, remotesErr := gitworktree.Remotes(focused.Path)
		if remotesErr != nil {
			jsonError(w, remotesErr.Error(), http.StatusInternalServerError)
			return
		}
		remote := gitworktree.PublishRemote(remotes)
		if remote == "" {
			jsonError(w, "There is no remote to publish to, or several and none is called origin. Add or choose one in a terminal.", http.StatusConflict)
			return
		}
		err = gitworktree.Publish(ctx, focused.Path, remote, branch)
	}
	s.resyncWorktrees(body.WorkspaceID)
	if err != nil {
		jsonError(w, syncRefusal(body.Action, branch, status.Upstream, err), http.StatusConflict)
		return
	}
	jsonOK(w, map[string]any{"action": body.Action, "branch": branch})
}

func (s *Server) beginSync(workspaceID string) bool {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	if s.syncing[workspaceID] {
		return false
	}
	s.syncing[workspaceID] = true
	return true
}

func (s *Server) endSync(workspaceID string) {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	delete(s.syncing, workspaceID)
}

// syncRefusal says what Git's refusal means and what to do about it, keeping
// Git's own words for anything it does not recognise.
func syncRefusal(action, branch, upstream string, err error) string {
	var refusal *gitworktree.SyncError
	output := err.Error()
	if errors.As(err, &refusal) {
		output = refusal.Output + "\n" + refusal.Err.Error()
	}
	lower := strings.ToLower(output)
	remote := upstream
	if remote == "" {
		remote = "the remote"
	}
	switch {
	case strings.Contains(lower, "no answer from the remote"):
		return fmt.Sprintf("%s did not answer in time. Check your connection and try again.", remote)
	case strings.Contains(lower, "terminal prompts disabled"), strings.Contains(lower, "authentication failed"),
		strings.Contains(lower, "could not read username"), strings.Contains(lower, "permission denied (publickey"),
		strings.Contains(lower, "could not read from remote repository"), strings.Contains(lower, "invalid username or password"):
		return "Git could not sign in to the remote. Ambio uses your saved Git credentials; run the same command once in a terminal to sign in, then try again."
	case strings.Contains(lower, "could not resolve host"), strings.Contains(lower, "unable to access"), strings.Contains(lower, "network is unreachable"):
		return fmt.Sprintf("Could not reach %s. Check your connection and try again.", remote)
	case action == "pull" && (strings.Contains(lower, "not possible to fast-forward") || strings.Contains(lower, "diverging branches")):
		return fmt.Sprintf("%s and %s have both moved on, so this is a merge, not a pull. Merge them in your editor or terminal for now; merging in Ambio is coming.", branch, remote)
	case action == "pull" && strings.Contains(lower, "would be overwritten"):
		return "Some of your uncommitted changes are in files the new commits change. Commit or set those changes aside, then pull."
	case action == "pull" && strings.Contains(lower, "untracked working tree files would be"):
		return "Some new files in the incoming commits already exist here, untracked. Move or remove them, then pull."
	case (action == "push" || action == "publish") && (strings.Contains(lower, "non-fast-forward") || strings.Contains(lower, "fetch first") || strings.Contains(lower, "[rejected]")):
		return fmt.Sprintf("%s has commits you do not have yet. Pull first, then push.", remote)
	case strings.Contains(lower, "protected branch"), strings.Contains(lower, "pre-receive hook declined"):
		return fmt.Sprintf("%s refused the push (a protected branch or a server rule). %s", remote, firstLine(output))
	}
	return firstLine(output)
}

func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return "Git refused without saying why."
}
