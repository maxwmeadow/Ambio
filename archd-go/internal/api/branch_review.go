package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/delta"
	"ambio.local/archd/internal/gitworktree"
	"ambio.local/archd/internal/indexer"
)

// Review a branch (docs/GIT_AND_PROJECT_SHAPES.md, stage 3): the
// architecture of what a branch changes against its base - in effect the
// architecture of a pull request. It is computed from Git, not the journal,
// so it covers work done anywhere: an agent's worktree, another machine, a
// branch Ambio never had on the Floor.
//
// Each changed file is read at the base and at the branch, its imports are
// resolved against the map on either side (indexer.ResolveImports), and the
// differences become the same journal-shaped events Review Changes
// aggregates. delta.BuildClaims then words them exactly as it words a
// morning's work: "Payments now depends on Email".

type branchReview struct {
	WorkspaceID string `json:"workspaceId"`
	RootID      string `json:"rootId"`
	Branch      string `json:"branch"`
	HeadCommit  string `json:"headCommit"`
	// Base is what the branch is compared with, as asked or chosen, and
	// BaseCommit where the two diverged.
	Base       string        `json:"base"`
	BaseCommit string        `json:"baseCommit"`
	Files      int           `json:"files"`
	Truncated  int           `json:"truncated,omitempty"`
	Counts     delta.Counts  `json:"counts"`
	Claims     []delta.Claim `json:"claims"`
	// Message explains an empty review: nothing to compare with, no commits.
	Message string `json:"message,omitempty"`
}

// GET /api/checkouts/review?workspace=&root=&base=
func (s *Server) handleBranchReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	query := r.URL.Query()
	workspaceID := query.Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	review, status, err := s.reviewBranch(sqlDB, workspaceID, query.Get("root"), query.Get("base"))
	if err != nil {
		jsonError(w, err.Error(), status)
		return
	}
	jsonOK(w, review)
}

func (s *Server) reviewBranch(sqlDB *sql.DB, workspaceID, rootID, base string) (branchReview, int, error) {
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil {
		return branchReview{}, http.StatusInternalServerError, err
	}
	var focused, target *db.Root
	s.mu.RLock()
	for index := range roots {
		if _, watched := s.watchers[roots[index].ID]; watched {
			focused = &roots[index]
		}
		if roots[index].ID == rootID {
			target = &roots[index]
		}
	}
	s.mu.RUnlock()
	if focused == nil {
		return branchReview{}, http.StatusConflict, fmt.Errorf("this project is not open")
	}
	if rootID == "" {
		target = focused
	}
	if target == nil {
		return branchReview{}, http.StatusNotFound, fmt.Errorf("that checkout is not part of this project")
	}
	review := branchReview{
		WorkspaceID: workspaceID, RootID: target.ID, Branch: target.Branch,
		HeadCommit: target.HeadCommit, Claims: []delta.Claim{},
	}
	switch headStateOf(*target) {
	case headNone:
		review.Message = "This folder is not a Git repository, so there is no branch to review."
		return review, http.StatusOK, nil
	case headUnborn:
		review.Message = "No commits yet: a branch can be reviewed after its first commit."
		return review, http.StatusOK, nil
	}

	// Another checkout is compared with the Floor's branch; the Floor's own
	// branch with the repository's default branch.
	if base == "" {
		if target.ID != focused.ID {
			base = focused.Branch
			if base == "" || base == gitworktree.DetachedBranch {
				base = focused.HeadCommit
			}
		} else {
			base = gitworktree.DefaultBranch(target.Path)
		}
	}
	review.Base = base
	if base == "" {
		review.Message = "There is no main branch to compare with. Choose one to compare against."
		return review, http.StatusOK, nil
	}
	baseRef, err := gitworktree.ResolveCommit(target.Path, base)
	if err != nil {
		return branchReview{}, http.StatusBadRequest, fmt.Errorf("no branch or commit named %q", base)
	}
	baseCommit, err := gitworktree.MergeBase(target.Path, baseRef, target.HeadCommit)
	if err != nil {
		return branchReview{}, http.StatusInternalServerError, err
	}
	review.BaseCommit = baseCommit

	floorFiles, err := db.GetFilesByRoot(sqlDB, focused.ID)
	if err != nil {
		return branchReview{}, http.StatusInternalServerError, err
	}
	systems, err := db.GetSystems(sqlDB, workspaceID)
	if err != nil {
		return branchReview{}, http.StatusInternalServerError, err
	}
	names := make(map[string]string, len(systems))
	for _, system := range systems {
		names[system.ID] = system.Name
	}
	events, files, truncated, err := branchEvents(*target, floorFiles, names, baseCommit, s.branchActor(sqlDB, workspaceID, *target))
	if err != nil {
		return branchReview{}, http.StatusInternalServerError, err
	}
	if files == 0 {
		review.Message = fmt.Sprintf("%s changes nothing Ambio maps against %s.", displayBranch(*target), base)
		return review, http.StatusOK, nil
	}
	for index := range events {
		events[index].WorkspaceID, events[index].RootID, events[index].Branch = workspaceID, target.ID, target.Branch
	}
	now := time.Now().UnixMilli()
	summary := delta.Aggregate(events, 0, now)
	summary.RootID, summary.Branch = target.ID, target.Branch
	review.Files, review.Truncated, review.Counts = files, truncated, summary.Counts
	review.Claims = delta.BuildClaims(summary, s.systemTopologyForRoot(sqlDB, workspaceID, focused.ID))
	if review.Claims == nil {
		review.Claims = []delta.Claim{}
	}
	return review, http.StatusOK, nil
}

func displayBranch(root db.Root) string {
	if root.Branch == "" || root.Branch == gitworktree.DetachedBranch {
		return "This checkout"
	}
	return root.Branch
}

// branchActor credits a branch's work to its agent when one is working there.
func (s *Server) branchActor(sqlDB *sql.DB, workspaceID string, root db.Root) string {
	if sessions, err := db.GetActiveWorkSessionsForRoot(sqlDB, workspaceID, root.ID, root.Branch); err == nil && len(sessions) > 0 {
		return delta.ActorAgent
	}
	return delta.ActorHuman
}

// branchEvents turns what root changes since base into journal-shaped events:
// a file event per changed file, and an import edge added or removed wherever
// a changed file's resolved imports differ between the two sides.
func branchEvents(root db.Root, floorFiles []db.File, names map[string]string, base, actor string) ([]db.StructuralEvent, int, int, error) {
	checkout, err := gitworktree.Locate(root.Path)
	if err != nil {
		return nil, 0, 0, err
	}
	tree, err := cachedTree(checkout, base)
	if err != nil {
		return nil, 0, 0, err
	}
	paths, err := gitworktree.ChangedSince(root.Path, base)
	if err != nil {
		return nil, 0, 0, err
	}
	changed := make([]string, 0, len(paths))
	for _, relPath := range paths {
		if indexer.InScope(root, relPath) {
			changed = append(changed, relPath)
		}
	}
	truncated := 0
	if len(changed) > overlayFileLimit {
		truncated = len(changed) - overlayFileLimit
		changed = changed[:overlayFileLimit]
	}
	if len(changed) == 0 {
		return nil, 0, 0, nil
	}

	scratch, err := os.MkdirTemp("", "ambio-branch-review-")
	if err != nil {
		return nil, 0, 0, err
	}
	defer os.RemoveAll(scratch)

	// The map on either side: the Floor's files, re-rooted into this
	// checkout so Go modules resolve from its go.mod, with the branch's
	// additions after and its deletions before.
	floorByPath := make(map[string]db.File, len(floorFiles))
	systemOf := map[string]string{}
	for _, file := range floorFiles {
		relPath := filepath.ToSlash(file.RelPath)
		floorByPath[relPath] = file
		if file.SystemID != nil {
			systemOf[file.ID] = *file.SystemID
		}
	}
	folders := newFolderSystems(floorFiles)
	idOf := func(relPath string) string {
		if file, ok := floorByPath[relPath]; ok {
			return file.ID
		}
		return "branch:" + relPath
	}
	type side struct{ before, after bool }
	sides := make(map[string]side, len(changed))
	for _, relPath := range changed {
		_, inBase := tree[checkout.Prefix+relPath]
		_, statErr := os.Stat(filepath.Join(root.Path, filepath.FromSlash(relPath)))
		sides[relPath] = side{before: inBase, after: statErr == nil}
		if _, onFloor := floorByPath[relPath]; !onFloor {
			systemOf[idOf(relPath)] = folders.owner(relPath)
		}
	}
	version := func(after bool) []db.File {
		files := make([]db.File, 0, len(floorFiles)+len(changed))
		for _, file := range floorFiles {
			relPath := filepath.ToSlash(file.RelPath)
			if present, isChanged := sides[relPath]; isChanged && !(after && present.after || !after && present.before) {
				continue
			}
			file.Path = filepath.Join(root.Path, filepath.FromSlash(relPath))
			files = append(files, file)
		}
		for relPath, present := range sides {
			if _, onFloor := floorByPath[relPath]; onFloor {
				continue
			}
			if after && present.after || !after && present.before {
				files = append(files, db.File{
					ID: idOf(relPath), RelPath: relPath,
					Path: filepath.Join(root.Path, filepath.FromSlash(relPath)),
				})
			}
		}
		return files
	}
	before, after := version(false), version(true)
	pathOfID := map[string]string{}
	for relPath := range sides {
		pathOfID[idOf(relPath)] = relPath
	}
	for _, file := range floorFiles {
		pathOfID[file.ID] = filepath.ToSlash(file.RelPath)
	}
	nameOf := func(id string) string {
		if relPath, ok := pathOfID[id]; ok {
			return relPath
		}
		return strings.TrimPrefix(id, "branch:")
	}

	events := make([]db.StructuralEvent, 0, len(changed)*2)
	ts := int64(1)
	record := func(event db.StructuralEvent) {
		event.Actor, event.TS = actor, ts
		ts++
		events = append(events, event)
	}
	for _, relPath := range changed {
		present := sides[relPath]
		id := idOf(relPath)
		file := db.File{ID: id, RelPath: relPath}
		var beforeTargets, afterTargets []string
		if present.before {
			if content, readErr := checkout.Blob(tree[checkout.Prefix+relPath]); readErr == nil {
				scratchPath := filepath.Join(scratch, filepath.FromSlash(relPath))
				if os.MkdirAll(filepath.Dir(scratchPath), 0o755) == nil && os.WriteFile(scratchPath, content, 0o644) == nil {
					file.Path = filepath.Join(root.Path, filepath.FromSlash(relPath))
					beforeTargets, _ = indexer.ResolveImports(scratchPath, file, before)
				}
			}
		}
		if present.after {
			file.Path = filepath.Join(root.Path, filepath.FromSlash(relPath))
			afterTargets, _ = indexer.ResolveImports(file.Path, file, after)
		}
		kind := db.EventFileUpdated
		switch {
		case present.after && !present.before:
			kind = db.EventFileCreated
		case !present.after && present.before:
			kind = db.EventFileDeleted
		case present.after && present.before:
			if content, readErr := os.ReadFile(file.Path); readErr == nil && gitworktree.BlobID(content, tree[checkout.Prefix+relPath]) == tree[checkout.Prefix+relPath] {
				continue
			}
		default:
			continue
		}
		record(db.StructuralEvent{
			Kind: kind, SubjectID: id, SubjectLabel: relPath,
			Detail: branchDetail(map[string]string{"systemId": systemOf[id], "systemName": names[systemOf[id]]}),
		})
		beforeSet := map[string]bool{}
		for _, target := range beforeTargets {
			beforeSet[target] = true
		}
		afterSet := map[string]bool{}
		for _, target := range afterTargets {
			afterSet[target] = true
		}
		edge := func(kind, target string) {
			record(db.StructuralEvent{
				Kind: kind, SubjectID: id, SubjectLabel: relPath,
				ObjectID: target, ObjectLabel: nameOf(target),
				Detail: branchDetail(map[string]string{
					"relationship":  "IMPORTS",
					"srcSystem":     systemOf[id],
					"dstSystem":     systemOf[target],
					"srcSystemName": names[systemOf[id]],
					"dstSystemName": names[systemOf[target]],
				}),
			})
		}
		for _, target := range afterTargets {
			if !beforeSet[target] {
				edge(db.EventEdgeAdded, target)
			}
		}
		for _, target := range beforeTargets {
			if !afterSet[target] {
				edge(db.EventEdgeRemoved, target)
			}
		}
	}
	files := 0
	for _, event := range events {
		if event.Kind == db.EventFileCreated || event.Kind == db.EventFileUpdated || event.Kind == db.EventFileDeleted {
			files++
		}
	}
	return events, files, truncated, nil
}

func branchDetail(detail map[string]string) string {
	for key, value := range detail {
		if value == "" {
			delete(detail, key)
		}
	}
	encoded, err := json.Marshal(detail)
	if err != nil || len(detail) == 0 {
		return ""
	}
	return string(encoded)
}
