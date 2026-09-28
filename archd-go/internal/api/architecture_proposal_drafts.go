package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"axiom.local/archd/internal/db"
)

type beginProposalDraftRequest struct {
	WorkspaceID string `json:"workspaceId"`
	Rationale   string `json:"rationale"`
}

type addProposalDraftChunkRequest struct {
	WorkspaceID string           `json:"workspaceId"`
	ChunkID     string           `json:"chunkId"`
	Systems     []db.DraftSystem `json:"systems"`
}

type proposalDraftActionRequest struct {
	WorkspaceID string `json:"workspaceId"`
}

func (s *Server) handleArchitectureProposalDrafts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		drafts, err := db.ListOpenArchitectureProposalDrafts(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		summaries := make([]map[string]any, 0, len(drafts))
		for _, draft := range drafts {
			summaries = append(summaries, map[string]any{
				"sessionId": draft.ID, "rationale": draft.Rationale,
				"chunkCount": draft.ChunkCount, "systemCount": len(draft.Systems),
				"updatedAt": draft.UpdatedAt,
			})
		}
		jsonOK(w, summaries)
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var request beginProposalDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		jsonError(w, "bad request", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(request.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	draft, err := db.BeginArchitectureProposalDraft(sqlDB, request.WorkspaceID, request.Rationale)
	if err != nil {
		jsonError(w, err.Error(), proposalErrorStatus(err))
		return
	}
	s.hub.Broadcast("architecture:proposal-draft", map[string]any{"workspaceId": request.WorkspaceID, "sessionId": draft.ID, "systems": 0, "chunks": 0, "status": "open"})
	jsonOK(w, draft)
}

func (s *Server) handleArchitectureProposalDraftByID(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/architecture-proposal-drafts/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" || len(parts) > 2 {
		http.NotFound(w, r)
		return
	}
	id := parts[0]
	workspaceID := r.URL.Query().Get("workspace")
	var chunkRequest addProposalDraftChunkRequest
	var actionRequest proposalDraftActionRequest
	if r.Method == http.MethodPost {
		if len(parts) == 2 && parts[1] == "chunks" {
			if err := json.NewDecoder(r.Body).Decode(&chunkRequest); err != nil {
				jsonError(w, "bad request", http.StatusBadRequest)
				return
			}
			workspaceID = chunkRequest.WorkspaceID
		} else {
			if err := json.NewDecoder(r.Body).Decode(&actionRequest); err != nil {
				jsonError(w, "bad request", http.StatusBadRequest)
				return
			}
			workspaceID = actionRequest.WorkspaceID
		}
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	switch {
	case r.Method == http.MethodGet && len(parts) == 1:
		draft, err := db.GetArchitectureProposalDraft(sqlDB, id, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		jsonOK(w, draft)
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "chunks":
		draft, err := db.AddArchitectureProposalDraftChunk(sqlDB, id, workspaceID, chunkRequest.ChunkID, chunkRequest.Systems)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal-draft", map[string]any{"workspaceId": workspaceID, "sessionId": id, "systems": len(draft.Systems), "chunks": draft.ChunkCount, "status": draft.Status})
		jsonOK(w, draft)
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "commit":
		proposal, err := db.CommitArchitectureProposalDraft(sqlDB, id, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal-draft", map[string]any{"workspaceId": workspaceID, "sessionId": id, "status": "committed", "proposalId": proposal.ID})
		s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": workspaceID, "proposalId": proposal.ID})
		jsonOK(w, proposal)
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "abort":
		if err := db.AbortArchitectureProposalDraft(sqlDB, id, workspaceID); err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal-draft", map[string]any{"workspaceId": workspaceID, "sessionId": id, "status": "aborted"})
		jsonOK(w, map[string]string{"status": "aborted"})
	default:
		http.NotFound(w, r)
	}
}
