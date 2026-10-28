package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"ambio.local/archd/internal/collision"
	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
)

// Checkout head states, as the branch chip words them.
const (
	headCommit   = "commit"
	headDetached = "detached"
	headUnborn   = "unborn"
	headNone     = "none" // a plain folder: no Git at all
)

// checkoutStatus is one working copy of the project as the branch chip and
// Checkouts popover show it (docs/GIT_AND_PROJECT_SHAPES.md "The experience").
type checkoutStatus struct {
	RootID     string `json:"rootId"`
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	HeadCommit string `json:"headCommit"`
	HeadState  string `json:"headState"`
	IsPrimary  bool   `json:"isPrimary"`
	// IsAmbioRun marks a worktree Ambio made for an agent run, which it can
	// apply or discard (worktree_runs.go).
	IsAmbioRun bool `json:"isAmbioRun"`
	// IsFocused marks the checkout the Floor shows.
	IsFocused    bool   `json:"isFocused"`
	ChangedFiles int    `json:"changedFiles"`
	Upstream     string `json:"upstream,omitempty"`
	Ahead        int    `json:"ahead"`
	Behind       int    `json:"behind"`
	// FetchedAt is when the repository last heard from a remote (ms; 0 if
	// never), and PublishRemote where a branch without an upstream would be
	// published. Both are read for the Floor's checkout only.
	FetchedAt     int64             `json:"fetchedAt,omitempty"`
	PublishRemote string            `json:"publishRemote,omitempty"`
	Agents        []collision.Agent `json:"agents"`
	// TouchedSystems counts systems this checkout changes against the others;
	// CollidingSystems those another checkout changes too.
	TouchedSystems   int    `json:"touchedSystems"`
	CollidingSystems int    `json:"collidingSystems"`
	Error            string `json:"error,omitempty"`
	// Overlay is what this checkout changes against its merge base with the
	// Floor's checkout (overlays.go); empty for the Floor's own checkout.
	Overlay          []overlayFile `json:"overlay"`
	OverlayTruncated int           `json:"overlayTruncated,omitempty"`
}

type checkoutsCacheEntry struct {
	snapshot  checkoutsSnapshot
	expiresAt int64
}

type checkoutsSnapshot struct {
	WorkspaceID string `json:"workspaceId"`
	// VCS is "git"; "repos" for a folder that is not a checkout but holds
	// several repositories; "none" for a folder without Git at all.
	VCS        string                        `json:"vcs"`
	Checkouts  []checkoutStatus              `json:"checkouts"`
	Collisions []collision.BoundaryCollision `json:"collisions"`
	// Repositories nested in the Floor's folder: one of several under a
	// parent folder, or a submodule (docs/GIT_AND_PROJECT_SHAPES.md stage 6).
	Repositories []repositoryStatus `json:"repositories"`
}

type repositoryStatus struct {
	// Folder is relative to the Floor's checkout.
	Folder       string `json:"folder"`
	Branch       string `json:"branch"`
	HeadCommit   string `json:"headCommit"`
	HeadState    string `json:"headState"`
	ChangedFiles int    `json:"changedFiles"`
	Upstream     string `json:"upstream,omitempty"`
	Ahead        int    `json:"ahead"`
	Behind       int    `json:"behind"`
	Error        string `json:"error,omitempty"`
}

func repositoryState(folder string) repositoryStatus {
	status := repositoryStatus{HeadState: headCommit}
	checkout, err := gitworktree.Locate(folder)
	if err != nil {
		status.Error, status.HeadState = err.Error(), headNone
		return status
	}
	head, err := checkout.ReadHead()
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Branch, status.HeadCommit = head.Branch, head.Commit
	switch {
	case head.Branch == gitworktree.DetachedBranch:
		status.HeadState = headDetached
	case head.Commit == "":
		status.HeadState = headUnborn
	}
	if git, err := gitworktree.ReadStatus(folder); err == nil {
		status.ChangedFiles, status.Upstream, status.Ahead, status.Behind = git.ChangedFiles, git.Upstream, git.Ahead, git.Behind
	}
	return status
}

func headStateOf(root db.Root) string {
	switch {
	case root.Branch == "" && strings.Trim(root.HeadCommit, "0") == "":
		return headNone
	case root.Branch == gitworktree.DetachedBranch:
		return headDetached
	case strings.Trim(root.HeadCommit, "0") == "":
		return headUnborn
	}
	return headCommit
}

// GET /api/checkouts?workspace=...
func (s *Server) handleCheckouts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	if workspaceID == "" {
		jsonError(w, "workspace is required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	snapshot, err := s.checkouts(sqlDB, workspaceID, time.Now().UnixMilli())
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, snapshot)
}

// checkouts serves a snapshot at most collisionCacheTTL old, like collisions.
func (s *Server) checkouts(sqlDB *sql.DB, workspaceID string, now int64) (checkoutsSnapshot, error) {
	s.mu.RLock()
	cached, ok := s.checkoutsCache[workspaceID]
	s.mu.RUnlock()
	if ok && cached.expiresAt > now {
		return cached.snapshot, nil
	}
	snapshot, err := s.buildCheckouts(sqlDB, workspaceID, now)
	if err != nil {
		return checkoutsSnapshot{}, err
	}
	s.mu.Lock()
	s.checkoutsCache[workspaceID] = checkoutsCacheEntry{
		snapshot: snapshot, expiresAt: now + s.collisionCacheTTL.Milliseconds(),
	}
	s.mu.Unlock()
	return snapshot, nil
}

func (s *Server) buildCheckouts(sqlDB *sql.DB, workspaceID string, now int64) (checkoutsSnapshot, error) {
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil {
		return checkoutsSnapshot{}, err
	}
	collisions, err := s.cachedCrossBranchCollisions(sqlDB, workspaceID, now)
	if err != nil {
		return checkoutsSnapshot{}, err
	}
	branches := make(map[string]collision.Branch, len(collisions.Branches))
	for _, branch := range collisions.Branches {
		branches[branch.RootID] = branch
	}
	colliding := map[string]int{}
	for _, shared := range collisions.Collisions {
		for _, branch := range shared.Branches {
			colliding[branch.RootID]++
		}
	}

	snapshot := checkoutsSnapshot{
		WorkspaceID:  workspaceID,
		VCS:          "git",
		Checkouts:    make([]checkoutStatus, 0, len(roots)),
		Collisions:   collisions.Collisions,
		Repositories: []repositoryStatus{},
	}
	if snapshot.Collisions == nil {
		snapshot.Collisions = []collision.BoundaryCollision{}
	}
	s.mu.RLock()
	for _, root := range roots {
		_, watched := s.watchers[root.ID]
		branch := branches[root.ID]
		status := checkoutStatus{
			RootID:           root.ID,
			Path:             root.Path,
			Branch:           root.Branch,
			HeadCommit:       root.HeadCommit,
			HeadState:        headStateOf(root),
			IsPrimary:        root.IsPrimary,
			IsFocused:        watched,
			IsAmbioRun:       s.isAmbioWorktree(root),
			Agents:           branch.ActiveWork,
			TouchedSystems:   len(branch.TouchedSystems),
			CollidingSystems: colliding[root.ID],
		}
		if status.Agents == nil {
			status.Agents = []collision.Agent{}
		}
		status.Overlay = []overlayFile{}
		snapshot.Checkouts = append(snapshot.Checkouts, status)
	}
	s.mu.RUnlock()

	for index := range snapshot.Checkouts {
		checkout := &snapshot.Checkouts[index]
		if checkout.HeadState == headNone {
			continue
		}
		gitStatus, statusErr := gitworktree.ReadStatus(checkout.Path)
		if statusErr != nil {
			checkout.Error = statusErr.Error()
			continue
		}
		checkout.ChangedFiles = gitStatus.ChangedFiles
		checkout.Upstream, checkout.Ahead, checkout.Behind = gitStatus.Upstream, gitStatus.Ahead, gitStatus.Behind
		if checkout.IsFocused {
			if fetched := gitworktree.FetchedAt(checkout.Path); !fetched.IsZero() {
				checkout.FetchedAt = fetched.UnixMilli()
			}
			if remotes, err := gitworktree.Remotes(checkout.Path); err == nil {
				checkout.PublishRemote = gitworktree.PublishRemote(remotes)
			}
		}
	}
	var focused *db.Root
	for index := range roots {
		if snapshot.checkoutFocused(roots[index].ID) {
			focused = &roots[index]
		}
	}
	if focused != nil && len(roots) > 1 {
		floorFiles, filesErr := db.GetFilesByRoot(sqlDB, focused.ID)
		if filesErr != nil {
			return checkoutsSnapshot{}, filesErr
		}
		for index := range snapshot.Checkouts {
			checkout := &snapshot.Checkouts[index]
			if checkout.IsFocused {
				continue
			}
			for _, root := range roots {
				if root.ID != checkout.RootID {
					continue
				}
				overlay, truncated, overlayErr := checkoutOverlay(*focused, floorFiles, root)
				if overlayErr != nil {
					if checkout.Error == "" {
						checkout.Error = overlayErr.Error()
					}
					continue
				}
				checkout.Overlay, checkout.OverlayTruncated = overlay, truncated
			}
		}
	}
	if focused != nil {
		for _, folder := range s.cachedNestedRepositories(*focused) {
			repository := repositoryState(filepath.Join(focused.Path, filepath.FromSlash(folder)))
			repository.Folder = folder
			snapshot.Repositories = append(snapshot.Repositories, repository)
		}
	}
	if len(snapshot.Checkouts) == 1 && snapshot.Checkouts[0].HeadState == headNone {
		snapshot.VCS = "none"
		if len(snapshot.Repositories) > 0 {
			snapshot.VCS = "repos"
		}
	}

	// The Floor's checkout first, then Git's primary, then by branch.
	sort.SliceStable(snapshot.Checkouts, func(left, right int) bool {
		a, b := snapshot.Checkouts[left], snapshot.Checkouts[right]
		if a.IsFocused != b.IsFocused {
			return a.IsFocused
		}
		if a.IsPrimary != b.IsPrimary {
			return a.IsPrimary
		}
		return a.Branch < b.Branch
	})
	return snapshot, nil
}

func (snapshot checkoutsSnapshot) checkoutFocused(rootID string) bool {
	for _, checkout := range snapshot.Checkouts {
		if checkout.RootID == rootID {
			return checkout.IsFocused
		}
	}
	return false
}

// POST /api/checkouts/focus {workspaceId, rootId}
//
// Shows another checkout on the Floor ("Show on the Floor"). The projection
// moves to it with every file's identity (followCanonicalProjection), so the
// map is the same map at another branch, and nothing is journaled.
func (s *Server) handleCheckoutFocus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		RootID      string `json:"rootId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" || body.RootID == "" {
		jsonError(w, "workspaceId and rootId are required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	roots, err := db.GetActiveRoots(sqlDB, body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	found := false
	for _, root := range roots {
		if root.ID == body.RootID {
			found = true
		}
	}
	if !found {
		jsonError(w, "that checkout is not part of this project", http.StatusNotFound)
		return
	}
	s.mu.RLock()
	monitor, monitored := s.worktreeMonitors[body.WorkspaceID]
	s.mu.RUnlock()
	if !monitored {
		jsonError(w, "this project is not open", http.StatusConflict)
		return
	}
	if err := db.SetFocusedRoot(sqlDB, body.WorkspaceID, body.RootID); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.invalidateCollisionCache(body.WorkspaceID)
	select {
	case monitor.resync <- struct{}{}:
	default: // one is already queued
	}
	jsonOK(w, map[string]any{"workspaceId": body.WorkspaceID, "rootId": body.RootID})
}

type nestedCacheEntry struct {
	folders   []string
	expiresAt time.Time
}

// cachedNestedRepositories walks a root for repositories at most every 30 s:
// repositories inside a project appear and disappear rarely.
func (s *Server) cachedNestedRepositories(root db.Root) []string {
	s.mu.RLock()
	entry, ok := s.nestedCache[root.ID]
	s.mu.RUnlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.folders
	}
	folders := s.nestedRepositories(root)
	s.mu.Lock()
	s.nestedCache[root.ID] = nestedCacheEntry{folders: folders, expiresAt: time.Now().Add(30 * time.Second)}
	s.mu.Unlock()
	return folders
}
