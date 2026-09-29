package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"axiom.local/archd/internal/db"
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
	if _, err := os.Stat(filepath.Join(s.dataDir, req.WorkspaceID, "axiom.db")); os.IsNotExist(err) {
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
