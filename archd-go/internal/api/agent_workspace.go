package api

import (
	"axiom.local/archd/internal/db"
	"net/http"
	"os"
	"path/filepath"
)

// Persisted roots preserve routing across daemon restarts.
func (s *Server) handleAgentWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.NotFound(w, r)
		return
	}
	explicit := r.URL.Query().Get("workspace")
	cwd := r.URL.Query().Get("cwd")
	if explicit != "" && !validWorkspaceID(explicit) {
		jsonError(w, "invalid workspace", 400)
		return
	}
	if cwd != "" {
		if real, err := filepath.EvalSymlinks(cwd); err == nil {
			cwd = real
		}
		cwd = normalizedRootPath(cwd)
	}
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		jsonError(w, "open the project in Axiom first", 404)
		return
	}
	bestLength := -1
	ambiguous := false
	var best map[string]string
	for _, entry := range entries {
		id := entry.Name()
		if !entry.IsDir() || !validWorkspaceID(id) || (explicit != "" && id != explicit) {
			continue
		}
		if _, err := os.Stat(filepath.Join(s.dataDir, id, "axiom.db")); err != nil {
			continue
		}
		d, err := s.dbFor(id)
		if err != nil {
			continue
		}
		workspace, err := db.GetWorkspace(d, id)
		if err != nil || workspace == nil {
			continue
		}
		roots, err := db.GetRoots(d, id)
		if err != nil {
			continue
		}
		for _, root := range roots {
			if !root.IsActive {
				continue
			}
			path := root.Path
			if real, err := filepath.EvalSymlinks(path); err == nil {
				path = real
			}
			norm := normalizedRootPath(path)
			matches := cwd != "" && pathInsideRoot(cwd, norm)
			if !matches && explicit == "" {
				continue
			}
			length := len(norm)
			if !matches {
				length = 0
			}
			if length == bestLength && best != nil && best["workspaceId"] != id {
				ambiguous = true
			}
			if length > bestLength {
				bestLength = length
				ambiguous = false
				best = map[string]string{"workspaceId": id, "name": workspace.Name, "rootPath": root.Path, "rootId": root.ID, "branch": root.Branch}
			}
		}
	}
	if ambiguous {
		jsonError(w, "multiple workspaces match this directory; configure AXIOM_WORKSPACE_ID", 409)
		return
	}
	if best == nil {
		jsonError(w, "no registered workspace matches; open this project in Axiom or configure AXIOM_WORKSPACE_ID", 404)
		return
	}
	jsonOK(w, best)
}
