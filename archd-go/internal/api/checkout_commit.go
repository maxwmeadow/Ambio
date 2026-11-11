package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
)

// Committing from the branch menu (docs/GIT_WORKFLOW.md stage 2), on the
// Floor's checkout:
//
//	GET  /api/checkouts/changes?workspace=   every changed file, staged or not
//	POST /api/checkouts/stage   {workspaceId, paths, stage}   stage or unstage
//	POST /api/checkouts/discard {workspaceId, paths}          drop unstaged changes
//	POST /api/checkouts/commit  {workspaceId, message, all}   commit
//
// Paths are relative to the checkout's folder and must be among its current
// changes, so nothing outside what the person sees can be touched. One of
// these runs per project at a time. A commit moves HEAD, which the worktree
// monitor journals like a commit made anywhere else.

func (s *Server) handleCheckoutChanges(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.URL.Query().Get("workspace")
	focused, ok := s.commitCheckout(w, workspaceID)
	if !ok {
		return
	}
	changes, err := gitworktree.ReadChanges(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"branch": focused.Branch, "files": changes})
}

func (s *Server) handleStageChanges(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string   `json:"workspaceId"`
		Paths       []string `json:"paths"`
		Stage       bool     `json:"stage"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	s.changeFiles(w, r, body.WorkspaceID, body.Paths, func(ctx context.Context, dir string, picked []gitworktree.Change) error {
		paths := make([]string, len(picked))
		for index, change := range picked {
			paths[index] = change.Path
		}
		if body.Stage {
			return gitworktree.Stage(ctx, dir, paths)
		}
		return gitworktree.Unstage(ctx, dir, paths)
	})
}

func (s *Server) handleDiscardChanges(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string   `json:"workspaceId"`
		Paths       []string `json:"paths"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	s.changeFiles(w, r, body.WorkspaceID, body.Paths, gitworktree.Discard)
}

func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Message     string `json:"message"`
		All         bool   `json:"all"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	message := strings.TrimSpace(body.Message)
	if message == "" {
		jsonError(w, "Write a commit message first.", http.StatusBadRequest)
		return
	}
	focused, ok := s.commitCheckout(w, body.WorkspaceID)
	if !ok {
		return
	}
	if focused.Branch == "" || focused.Branch == gitworktree.DetachedBranch {
		jsonError(w, "This checkout is not on a branch. Switch to a branch before committing.", http.StatusConflict)
		return
	}
	changes, err := gitworktree.ReadChanges(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	staged, conflicted := 0, false
	for _, change := range changes {
		if change.Staged != "" {
			staged++
		}
		conflicted = conflicted || change.Conflicted
	}
	switch {
	case conflicted:
		jsonError(w, "Some files still have merge conflicts. Resolve them before committing.", http.StatusConflict)
		return
	case len(changes) == 0:
		jsonError(w, "There is nothing to commit.", http.StatusConflict)
		return
	case staged == 0 && !body.All:
		jsonError(w, "Nothing is staged. Stage the files to commit, or commit all of them.", http.StatusConflict)
		return
	}
	if !s.beginSync(indexLock(body.WorkspaceID)) {
		jsonError(w, "Ambio is already changing this checkout. Try again when it finishes.", http.StatusConflict)
		return
	}
	defer s.endSync(indexLock(body.WorkspaceID))
	commit, err := gitworktree.Commit(r.Context(), focused.Path, message, body.All)
	s.resyncWorktrees(body.WorkspaceID)
	if err != nil {
		jsonError(w, commitRefusal(err), http.StatusConflict)
		return
	}
	files := staged
	if body.All {
		files = len(changes)
	}
	jsonOK(w, map[string]any{"commit": commit, "branch": focused.Branch, "files": files})
}

// commitCheckout is the Floor's checkout for workspaceID, or a written error.
func (s *Server) commitCheckout(w http.ResponseWriter, workspaceID string) (db.Root, bool) {
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return db.Root{}, false
	}
	focused, _, err := s.focusedRoot(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return db.Root{}, false
	}
	return focused, true
}

// changeFiles runs work on the named paths once each is checked against the
// checkout's current changes.
func (s *Server) changeFiles(w http.ResponseWriter, r *http.Request, workspaceID string, paths []string,
	work func(ctx context.Context, dir string, picked []gitworktree.Change) error) {
	if len(paths) == 0 {
		jsonError(w, "paths is required", http.StatusBadRequest)
		return
	}
	for _, name := range paths {
		if !gitworktree.SafePath(name) {
			jsonError(w, fmt.Sprintf("%q is not a path in this checkout.", name), http.StatusBadRequest)
			return
		}
	}
	focused, ok := s.commitCheckout(w, workspaceID)
	if !ok {
		return
	}
	changes, err := gitworktree.ReadChanges(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	byPath := map[string]gitworktree.Change{}
	for _, change := range changes {
		byPath[change.Path] = change
	}
	picked := []gitworktree.Change{}
	for _, name := range paths {
		change, found := byPath[name]
		if !found {
			jsonError(w, fmt.Sprintf("%s has no changes now. Refresh and try again.", name), http.StatusConflict)
			return
		}
		picked = append(picked, change)
	}
	if !s.beginSync(indexLock(workspaceID)) {
		jsonError(w, "Ambio is already changing this checkout. Try again when it finishes.", http.StatusConflict)
		return
	}
	defer s.endSync(indexLock(workspaceID))
	err = work(r.Context(), focused.Path, picked)
	s.resyncWorktrees(workspaceID)
	if err != nil {
		jsonError(w, commitRefusal(err), http.StatusConflict)
		return
	}
	jsonOK(w, map[string]any{"files": len(picked)})
}

// indexLock keys index changes apart from network syncs, so staging is not
// refused while the menu's own fetch runs.
func indexLock(workspaceID string) string { return workspaceID + "\x00index" }

// commitRefusal says what Git's refusal means, keeping Git's own words for
// anything it does not recognise.
func commitRefusal(err error) string {
	var refusal *gitworktree.SyncError
	output := err.Error()
	if errors.As(err, &refusal) {
		output = refusal.Output + "\n" + refusal.Err.Error()
	}
	lower := strings.ToLower(output)
	switch {
	case strings.Contains(lower, "please tell me who you are"), strings.Contains(lower, "unable to auto-detect email"):
		return "Git does not know who you are yet. Set your name and email once in a terminal (git config --global user.name and user.email), then commit again."
	case strings.Contains(lower, "index.lock"):
		return "Another Git command is changing this repository right now. Try again when it finishes."
	case strings.Contains(lower, "gpg failed"), strings.Contains(lower, "failed to sign"):
		return "Git could not sign the commit. Commit once in a terminal to unlock your signing key, then try again."
	case strings.Contains(lower, "did not finish in time"):
		return "Git did not finish in time; a commit hook may be waiting for input. Commit in a terminal to see it."
	}
	return firstLine(output)
}
