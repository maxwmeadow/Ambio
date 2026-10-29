package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
)

// A worktree per run (docs/GIT_AND_PROJECT_SHAPES.md stage 4): an agent Ambio
// starts can work on its own branch in its own folder, so several work at
// once and each one's work stays reviewable on its own until someone applies
// it. Ambio makes these worktrees outside the repository, under
// ~/.ambio/worktrees/<workspace>/<slug>, on branches named ambio/<slug>, and
// only ever removes worktrees and branches it made.

const ambioBranchPrefix = "ambio/"

// worktreesRoot is ~/.ambio/worktrees beside archd's data directory.
func (s *Server) worktreesRoot() string {
	return filepath.Join(filepath.Dir(filepath.Clean(s.dataDir)), "worktrees")
}

// isAmbioWorktree reports whether Ambio made this checkout for a run.
func (s *Server) isAmbioWorktree(root db.Root) bool {
	// Git reports a worktree's long, resolved path; the data folder can be a
	// symlink (macOS /var) or a Windows 8.3 short name (C:\Users\RUNNER~1).
	inside, err := filepath.Rel(resolvedRootPath(s.worktreesRoot()), resolvedRootPath(root.Path))
	return err == nil && !strings.HasPrefix(inside, "..") && strings.HasPrefix(root.Branch, ambioBranchPrefix)
}

var slugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

func runSlug(name string) string {
	slug := strings.Trim(slugUnsafe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(slug) > 32 {
		slug = strings.TrimRight(slug[:32], "-")
	}
	if slug == "" {
		slug = "run"
	}
	suffix := make([]byte, 3)
	_, _ = rand.Read(suffix)
	return slug + "-" + hex.EncodeToString(suffix)
}

// focusedRoot is the checkout the Floor shows.
func (s *Server) focusedRoot(sqlDB *sql.DB, workspaceID string) (db.Root, []db.Root, error) {
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil {
		return db.Root{}, nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, root := range roots {
		if _, watched := s.watchers[root.ID]; watched {
			return root, roots, nil
		}
	}
	return db.Root{}, roots, fmt.Errorf("this project is not open")
}

func (s *Server) resyncWorktrees(workspaceID string) {
	s.mu.RLock()
	monitor, ok := s.worktreeMonitors[workspaceID]
	s.mu.RUnlock()
	if ok {
		select {
		case monitor.resync <- struct{}{}:
		default:
		}
	}
	s.invalidateCollisionCache(workspaceID)
}

// waitForRoot waits until worktree sync has registered (or dropped) a path.
// With a branch, it waits for the row to name it: a sync already running
// when the worktree was added can register it before Git has checked the
// branch out.
func waitForRoot(sqlDB *sql.DB, workspaceID, path string, present bool, branch string) (db.Root, bool) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		roots, _ := db.GetActiveRoots(sqlDB, workspaceID)
		found := false
		for _, root := range roots {
			if sameRootPath(root.Path, path) {
				if present && (branch == "" || root.Branch == branch) {
					return root, true
				}
				found = true
			}
		}
		if !present && !found {
			return db.Root{}, true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return db.Root{}, false
}

func decodeJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return false
	}
	return true
}

// POST /api/checkouts/worktree {workspaceId, name}
//
// Makes a worktree for a run from the Floor's commit and returns it once the
// project knows it, so the agent's MCP connection resolves to it by its cwd.
func (s *Server) handleCreateRunWorktree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Name        string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
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
	switch headStateOf(focused) {
	case headNone:
		jsonError(w, "This project is not a Git repository, so an agent cannot get its own worktree.", http.StatusConflict)
		return
	case headUnborn:
		jsonError(w, "No commits yet: an agent can get its own worktree after the first commit.", http.StatusConflict)
		return
	}
	checkout, err := gitworktree.Locate(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	slug := runSlug(body.Name)
	worktree := filepath.Join(s.worktreesRoot(), body.WorkspaceID, slug)
	if err := os.MkdirAll(filepath.Dir(worktree), 0o755); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	branch := ambioBranchPrefix + slug
	if err := gitworktree.AddWorktree(checkout.TopLevel, worktree, branch, focused.HeadCommit); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// An agent opened at a package of a monorepo works in that package.
	folder := filepath.Join(worktree, filepath.FromSlash(checkout.Prefix))
	s.resyncWorktrees(body.WorkspaceID)
	root, ok := waitForRoot(sqlDB, body.WorkspaceID, folder, true, branch)
	if !ok {
		jsonError(w, "the worktree was made but the project did not pick it up", http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"rootId": root.ID, "path": folder, "branch": branch})
}

// POST /api/checkouts/finish {workspaceId, rootId, action: "apply"|"discard"}
//
// Apply brings an Ambio run's work - its commits and uncommitted changes - to
// the Floor's checkout as uncommitted changes, for the user to review and
// commit, then removes the run's worktree and branch. Discard removes them
// and the work with them. Keeping a run needs no call: its worktree stays.
func (s *Server) handleFinishRunWorktree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		RootID      string `json:"rootId"`
		Action      string `json:"action"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	focused, roots, err := s.focusedRoot(sqlDB, body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}
	var run *db.Root
	for index := range roots {
		if roots[index].ID == body.RootID {
			run = &roots[index]
		}
	}
	if run == nil {
		jsonError(w, "that checkout is not part of this project", http.StatusNotFound)
		return
	}
	if !s.isAmbioWorktree(*run) {
		jsonError(w, "Ambio only finishes worktrees it made for its own runs.", http.StatusForbidden)
		return
	}
	if run.ID == focused.ID {
		jsonError(w, "Show another checkout on the Floor before finishing this one.", http.StatusConflict)
		return
	}
	checkout, err := gitworktree.Locate(run.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Git runs from the Floor's checkout: the run's folder is about to go.
	focusedCheckout, err := gitworktree.Locate(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	result := map[string]any{"action": body.Action, "into": focused.Branch}
	switch body.Action {
	case "apply":
		base, err := gitworktree.MergeBase(run.Path, focused.HeadCommit, run.HeadCommit)
		if err != nil {
			jsonError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		patch, paths, err := gitworktree.ChangesAsPatch(run.Path, base)
		if err != nil {
			jsonError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Never mix a run's work into uncommitted edits to the same files.
		if working, err := gitworktree.WorkingChangedPaths(focused.Path); err == nil {
			busy := map[string]bool{}
			for _, path := range working {
				busy[path] = true
			}
			var overlap []string
			for _, path := range paths {
				if busy[strings.TrimPrefix(path, checkout.Prefix)] {
					overlap = append(overlap, path)
				}
			}
			if len(overlap) > 0 {
				jsonError(w, fmt.Sprintf("%s has uncommitted changes to files this run also changes (%s). Commit or set them aside first.", focused.Branch, strings.Join(overlap, ", ")), http.StatusConflict)
				return
			}
		}
		conflicted, err := gitworktree.ApplyPatch(focusedCheckout.TopLevel, patch)
		if err != nil {
			jsonError(w, "The run's changes do not apply cleanly to "+focused.Branch+": "+err.Error(), http.StatusConflict)
			return
		}
		result["files"] = len(paths)
		if conflicted {
			// The work is in the Floor's checkout with conflict markers; the
			// worktree stays so nothing is lost while they are resolved.
			result["conflicted"] = true
			s.invalidateCollisionCache(body.WorkspaceID)
			jsonOK(w, result)
			return
		}
	case "discard":
	default:
		jsonError(w, `action must be "apply" or "discard"`, http.StatusBadRequest)
		return
	}
	if err := gitworktree.RemoveWorktree(focusedCheckout.TopLevel, checkout.TopLevel, run.Branch, true); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = os.Remove(filepath.Dir(checkout.TopLevel)) // the workspace's folder, once empty
	s.resyncWorktrees(body.WorkspaceID)
	waitForRoot(sqlDB, body.WorkspaceID, run.Path, false, "")
	jsonOK(w, result)
}

// POST /api/checkouts/switch {workspaceId, branch, create?}
//
// Switches the Floor's checkout to another branch, or with create to a new
// branch started where the Floor is. Refused with uncommitted changes, which
// Git would otherwise carry across or refuse halfway.
func (s *Server) handleSwitchBranch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Branch      string `json:"branch"`
		Create      bool   `json:"create"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Branch) == "" || strings.HasPrefix(body.Branch, "-") {
		jsonError(w, "branch is required", http.StatusBadRequest)
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
	status, err := gitworktree.ReadStatus(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if status.ChangedFiles > 0 {
		jsonError(w, fmt.Sprintf("%s has %d uncommitted change%s. Commit or set them aside before switching.", focused.Branch, status.ChangedFiles, plural(status.ChangedFiles)), http.StatusConflict)
		return
	}
	switchTo := gitworktree.Switch
	if body.Create {
		if !gitworktree.ValidBranchName(focused.Path, body.Branch) {
			jsonError(w, fmt.Sprintf("%q is not a name Git allows for a branch.", body.Branch), http.StatusBadRequest)
			return
		}
		switchTo = gitworktree.CreateBranch
	}
	if err := switchTo(focused.Path, body.Branch); err != nil {
		message := err.Error()
		if strings.Contains(message, "already exists") {
			message = "A branch called " + body.Branch + " already exists."
		}
		if strings.Contains(message, "already checked out") || strings.Contains(message, "already used by worktree") {
			message = body.Branch + " is checked out in another worktree. Use Show on the Floor for that checkout instead."
		}
		jsonError(w, message, http.StatusConflict)
		return
	}
	s.resyncWorktrees(body.WorkspaceID)
	jsonOK(w, map[string]any{"branch": body.Branch})
}

// GET /api/checkouts/branches?workspace=
//
// Local branches for the branch menu, with where each stands against its
// upstream, its last commit and the checkout it is open in.
func (s *Server) handleBranches(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	focused, roots, err := s.focusedRoot(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}
	listed, err := gitworktree.LocalBranches(focused.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	openIn := map[string]string{}
	for _, root := range roots {
		openIn[root.Branch] = root.ID
	}
	type branch struct {
		gitworktree.Branch
		RootID string `json:"rootId,omitempty"`
	}
	branches := make([]branch, 0, len(listed))
	for _, listedBranch := range listed {
		branches = append(branches, branch{Branch: listedBranch, RootID: openIn[listedBranch.Name]})
	}
	jsonOK(w, map[string]any{"current": focused.Branch, "branches": branches})
}

// POST /api/checkouts/branches/delete {workspaceId, branch}
//
// Deletes a local branch whose commits are safe elsewhere. Git refuses a
// branch with commits found nowhere else, and Ambio says so rather than
// forcing (DECISIONS 2026-10-28).
func (s *Server) handleDeleteBranch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Branch      string `json:"branch"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Branch) == "" || strings.HasPrefix(body.Branch, "-") {
		jsonError(w, "branch is required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	focused, roots, err := s.focusedRoot(sqlDB, body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}
	for _, root := range roots {
		if root.Branch == body.Branch {
			jsonError(w, fmt.Sprintf("%s is checked out in %s. Switch that checkout to another branch first.", body.Branch, root.Path), http.StatusConflict)
			return
		}
	}
	if err := gitworktree.DeleteBranch(focused.Path, body.Branch); err != nil {
		message := err.Error()
		switch {
		case strings.Contains(message, "not fully merged"):
			message = body.Branch + " has commits that are on no other branch, so deleting it would lose them. Merge or push it first."
		case strings.Contains(message, "not found"):
			message = "There is no branch called " + body.Branch + "."
		}
		jsonError(w, message, http.StatusConflict)
		return
	}
	jsonOK(w, map[string]any{"branch": body.Branch})
}
