package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
)

// Meaning edits: one recorded path for every change to what the architecture
// says - naming, grouping and nesting systems, and which system a file belongs
// to - whoever makes it (docs/PRODUCT.md §2, db/meaning.go).
//
//	POST /api/architecture/edits    {workspaceId, actor, edits[]}
//	POST /api/architecture/undo     {workspaceId, actor, eventIds[]} - reverse edits from Review Changes
//	GET  /api/architecture/changes?workspace=&since=  - net meaning changes, for agents
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

type meaningUndoReq struct {
	WorkspaceID string           `json:"workspaceId"`
	Actor       *db.MeaningActor `json:"actor"`
	EventIDs    []int64          `json:"eventIds"`
}

func (s *Server) handleArchitectureUndo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req meaningUndoReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Actor == nil {
		jsonError(w, "actor is required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(req.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	result, err := db.UndoMeaningEvents(sqlDB, req.WorkspaceID, *req.Actor, req.EventIDs)
	if err != nil {
		jsonError(w, err.Error(), meaningStatus(err))
		return
	}
	s.broadcastMeaning(req.WorkspaceID, result)
	jsonOK(w, result)
}

// handleArchitectureChanges tells an agent what people and agents changed
// about the map recently - by default the last seven days - so it starts work
// from the architecture as it is now, not as it last saw it.
func (s *Server) handleArchitectureChanges(w http.ResponseWriter, r *http.Request) {
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
	now := time.Now().UnixMilli()
	since := now - 7*24*60*60*1000
	if raw := r.URL.Query().Get("since"); raw != "" {
		if parsed, parseErr := strconv.ParseInt(raw, 10, 64); parseErr == nil {
			since = parsed
		}
	}
	events, err := db.GetStructuralEvents(sqlDB, workspaceID, since)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	meaningEvents := []db.StructuralEvent{}
	for _, ev := range events {
		if delta.IsMeaningEvent(ev) {
			meaningEvents = append(meaningEvents, ev)
		}
	}
	summary := delta.Aggregate(meaningEvents, since, now)
	fileIDs := []string{}
	for _, change := range summary.Meaning {
		fileIDs = append(fileIDs, meaningChangeFiles(change)...)
	}
	disagrees := []map[string]string{}
	if findings, fitErr := db.CodeFit(sqlDB, workspaceID, fileIDs); fitErr == nil {
		for _, finding := range findings {
			disagrees = append(disagrees, map[string]string{"where": finding.Summary, "toFix": finding.Ask})
		}
	}
	jsonOK(w, map[string]any{"since": since, "changes": summary.Meaning, "codeDisagrees": disagrees})
}

// meaningChangeFiles are the files a meaning change placed somewhere.
func meaningChangeFiles(change delta.MeaningChange) []string {
	switch change.Kind {
	case "moved":
		return []string{change.SubjectID}
	case "grouped", "merged":
		return change.FileIDs
	}
	return nil
}

// attachCodeFit marks the meaning claims in a review whose files the code
// still disagrees with, so an offer missed in the moment is not lost.
func attachCodeFit(sqlDB *sql.DB, workspaceID string, claims []delta.Claim) []delta.Claim {
	fileIDs := []string{}
	for _, claim := range claims {
		if claimPlacesFiles(claim.Kind) {
			fileIDs = append(fileIDs, claim.FocusFileIDs...)
		}
	}
	if len(fileIDs) == 0 {
		return claims
	}
	findings, err := db.CodeFit(sqlDB, workspaceID, fileIDs)
	if err != nil {
		log.Printf("[archd] code fit for review: %v", err)
		return claims
	}
	byFile := map[string][]db.CodeFitFinding{}
	for _, finding := range findings {
		byFile[finding.FileID] = append(byFile[finding.FileID], finding)
	}
	for i := range claims {
		if !claimPlacesFiles(claims[i].Kind) {
			continue
		}
		for _, fileID := range claims[i].FocusFileIDs {
			claims[i].CodeFit = append(claims[i].CodeFit, byFile[fileID]...)
		}
	}
	return claims
}

func claimPlacesFiles(kind delta.ClaimKind) bool {
	return kind == delta.ClaimMoved || kind == delta.ClaimGrouped || kind == delta.ClaimMerged
}

func meaningStatus(err error) int {
	switch {
	case errors.Is(err, db.ErrMeaningConflict):
		return http.StatusConflict
	case errors.Is(err, db.ErrMeaningEdit):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
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
		jsonError(w, err.Error(), meaningStatus(err))
		return db.MeaningResult{}, false
	}
	s.broadcastMeaning(workspaceID, result)
	result.CodeFit = codeFitAfter(sqlDB, workspaceID, result)
	return result, true
}

// codeFitAfter checks the files a batch placed in a system against the code,
// so whoever made the edit is offered the work that would make the code agree.
// A failed check never fails the edit, which has already been recorded.
func codeFitAfter(sqlDB *sql.DB, workspaceID string, result db.MeaningResult) []db.CodeFitFinding {
	fileIDs := []string{}
	for _, assignment := range result.Assignments {
		if assignment.SystemID != nil {
			fileIDs = append(fileIDs, assignment.FileID)
		}
	}
	findings, err := db.CodeFit(sqlDB, workspaceID, fileIDs)
	if err != nil {
		log.Printf("[archd] code fit after meaning edit: %v", err)
		return nil
	}
	return findings
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
