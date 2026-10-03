package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/indexer"
)

type relocateWorkspaceReq struct {
	WorkspaceID string `json:"workspaceId"`
	FromPath    string `json:"fromPath"`
	ToPath      string `json:"toPath"`
}

// handleWorkspaceRelocate handles POST /api/workspace-relocate. A project
// folder that was moved or renamed keeps its whole map: the root that pointed
// at fromPath is repointed at toPath instead of a second, empty root being
// registered beside it. The caller re-opens the workspace afterwards, which
// reconciles whatever changed on disk while the folder was away.
func (s *Server) handleWorkspaceRelocate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req relocateWorkspaceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "bad request", http.StatusBadRequest)
		return
	}
	if !validWorkspaceID(req.WorkspaceID) || req.FromPath == "" || req.ToPath == "" {
		jsonError(w, "workspaceId, fromPath and toPath are required", http.StatusBadRequest)
		return
	}
	toPath := filepath.Clean(req.ToPath)
	if info, err := os.Stat(toPath); err != nil || !info.IsDir() {
		jsonError(w, "the new location is not a readable folder", http.StatusBadRequest)
		return
	}
	// A project that was never indexed has nothing to carry over.
	if _, err := os.Stat(filepath.Join(s.dataDir, req.WorkspaceID, "ambio.db")); os.IsNotExist(err) {
		jsonOK(w, map[string]any{"relocated": false})
		return
	}
	sqlDB, err := s.dbFor(req.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	roots, err := db.GetRoots(sqlDB, req.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var target *db.Root
	for i := range roots {
		if sameRootPath(roots[i].Path, toPath) {
			jsonError(w, "this project already has a folder at the new location", http.StatusConflict)
			return
		}
		if target == nil && sameRootPath(roots[i].Path, req.FromPath) {
			target = &roots[i]
		}
	}
	if target == nil {
		jsonOK(w, map[string]any{"relocated": false})
		return
	}
	s.stopWatcher(target.ID)
	if err := db.RelocateRoot(sqlDB, target.ID, target.Path, toPath); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"relocated": true, "rootId": target.ID})
}

type reindexWorkspaceReq struct {
	WorkspaceID string `json:"workspaceId"`
}

// handleWorkspaceReindex handles POST /api/workspace-reindex: re-read every
// file of the workspace's live roots in place. See indexer.ReindexRootInPlace.
func (s *Server) handleWorkspaceReindex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req reindexWorkspaceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validWorkspaceID(req.WorkspaceID) {
		jsonError(w, "workspaceId is required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(req.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	// Only roots with a live watcher own the graph; linked worktrees do not.
	s.mu.Lock()
	var roots []db.Root
	for _, root := range s.roots {
		if root.WorkspaceID == req.WorkspaceID {
			roots = append(roots, root)
			s.rootForceReindex[root.ID] = true
		}
	}
	s.mu.Unlock()
	if len(roots) == 0 {
		jsonError(w, "open the project in Ambio first", http.StatusConflict)
		return
	}
	for _, root := range roots {
		s.launchRootSync(sqlDB, root, false)
	}
	jsonOK(w, map[string]any{"reindexing": len(roots)})
}

// handleWorkspaceIndexCancel handles POST /api/workspace-index-cancel: stop a
// running full index, typically because the user saw it was reading far more
// than they meant to. See indexer.CancelIndexing.
func (s *Server) handleWorkspaceIndexCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req reindexWorkspaceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validWorkspaceID(req.WorkspaceID) {
		jsonError(w, "workspaceId is required", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	cancelled := 0
	for _, root := range s.roots {
		if root.WorkspaceID == req.WorkspaceID {
			indexer.CancelIndexing(root.ID)
			cancelled++
		}
	}
	s.mu.Unlock()
	jsonOK(w, map[string]any{"cancelled": cancelled})
}
