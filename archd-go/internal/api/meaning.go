package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"axiom.local/archd/internal/db"
)

// Meaning edits: one recorded path for every change to what the architecture
// says - naming, grouping and nesting systems, and which system a file belongs
// to - whoever makes it (docs/PRODUCT.md §2, db/meaning.go).
//
//	POST /api/architecture/edits  {workspaceId, actor, edits[]}
//
// The older system and file routes stay for compatibility and funnel their
// meaning changes through the same path, so no change escapes the journal.

type meaningEditsReq struct {
	WorkspaceID string           `json:"workspaceId"`
	Actor       *db.MeaningActor `json:"actor"`
	Edits       []db.MeaningEdit `json:"edits"`
}

func (s *Server) handleArchitectureEdits(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req meaningEditsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "bad request", http.StatusBadRequest)
		return
	}
	result, ok := s.applyMeaning(w, req.WorkspaceID, req.Actor, req.Edits)
	if !ok {
		return
	}
	jsonOK(w, result)
}

// applyMeaning applies a batch, broadcasts what changed and writes any error
// response. It reports whether the caller should continue.
func (s *Server) applyMeaning(
	w http.ResponseWriter, workspaceID string, actor *db.MeaningActor, edits []db.MeaningEdit,
) (db.MeaningResult, bool) {
	if actor == nil {
		jsonError(w, "actor is required: {kind: human} or {kind: agent, agent: <name>}", http.StatusBadRequest)
		return db.MeaningResult{}, false
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return db.MeaningResult{}, false
	}
	result, err := db.ApplyMeaningEdits(sqlDB, workspaceID, *actor, edits)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, db.ErrMeaningEdit) {
			status = http.StatusBadRequest
		}
		jsonError(w, err.Error(), status)
		return db.MeaningResult{}, false
	}
	s.broadcastMeaning(workspaceID, result)
	return result, true
}

func (s *Server) broadcastMeaning(workspaceID string, result db.MeaningResult) {
	for _, system := range result.UpsertedSystems {
		s.broadcastPatch("system:upserted", system)
	}
	for _, assignment := range result.Assignments {
		s.broadcastPatch("file:assigned", map[string]any{
			"fileId": assignment.FileID, "systemId": assignment.SystemID, "workspaceId": workspaceID,
		})
	}
	for _, id := range result.DeletedSystemIDs {
		s.broadcastPatch("system:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
	}
}

// meaningEditsBetween turns a full system write from an older caller into the
// meaning edits it implies. Fields that only affect presentation are ignored.
func meaningEditsBetween(stored, requested db.System) []db.MeaningEdit {
	edits := []db.MeaningEdit{}
	if requested.Name != "" && requested.Name != stored.Name {
		edits = append(edits, db.MeaningEdit{Op: db.MeaningRename, SystemID: stored.ID, Name: requested.Name})
	}
	if !sameOptional(stored.ParentID, requested.ParentID) {
		edits = append(edits, db.MeaningEdit{Op: db.MeaningNest, SystemID: stored.ID, ParentID: requested.ParentID})
	}
	if !sameOptional(stored.Description, requested.Description) {
		edits = append(edits, db.MeaningEdit{Op: db.MeaningDescribe, SystemID: stored.ID, Description: requested.Description})
	}
	return edits
}

// confirmsInferredBoundary is the one source change an older caller may make
// directly: a person confirming a clustered system as theirs.
func confirmsInferredBoundary(stored, requested db.System) bool {
	inferred := stored.Source == "cluster" || stored.Source == "directory"
	return inferred && (requested.Source == "user" || requested.Source == "agent")
}

func sameOptional(a, b *string) bool {
	if a == nil || *a == "" {
		return b == nil || *b == ""
	}
	return b != nil && *a == *b
}
