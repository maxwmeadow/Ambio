package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"ambio.local/archd/internal/db"
	"github.com/google/uuid"
)

type mappingContextKey struct{}

func mappingSecret() (string, string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", err
	}
	secret := hex.EncodeToString(raw[:])
	hash := sha256.Sum256([]byte(secret))
	return secret, hex.EncodeToString(hash[:]), nil
}

func mappingToken(workspaceID, id, secret string) string {
	return "ambio-map." + base64.RawURLEncoding.EncodeToString([]byte(workspaceID)) + "." + id + "." + secret
}

// A mapping process receives a revocable bearer credential, never the desktop's
// general API token. Its route allowlist also applies to unadvertised/legacy
// tools and direct HTTP calls. Checking only the prompt/tool listing is unsafe.
func (s *Server) RequireAPIToken(token string, next http.Handler) http.Handler {
	general := RequireLocalToken(token, next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !strings.HasPrefix(provided, "ambio-map.") {
			general.ServeHTTP(w, r)
			return
		}
		parts := strings.Split(provided, ".")
		if len(parts) != 4 {
			jsonError(w, "invalid mapping credential", http.StatusUnauthorized)
			return
		}
		workspace, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			jsonError(w, "invalid mapping credential", http.StatusUnauthorized)
			return
		}
		sqlDB, err := s.dbFor(string(workspace))
		if err != nil {
			jsonError(w, "mapping workspace unavailable", http.StatusUnauthorized)
			return
		}
		m, err := db.GetMappingAttempt(sqlDB, string(workspace), parts[2])
		hash := sha256.Sum256([]byte(parts[3]))
		if err != nil || subtle.ConstantTimeCompare([]byte(m.TokenHash), []byte(hex.EncodeToString(hash[:]))) != 1 {
			jsonError(w, "invalid mapping credential", http.StatusUnauthorized)
			return
		}
		base := "/api/mapping-attempts/" + m.ID
		if m.State != "mapping" && !(r.Method == http.MethodPost && r.URL.Path == base+"/submit" && m.State == "submitted") {
			jsonError(w, "Mapping committed or cancelled. This session is permanently closed; do not start work or call more tools.", http.StatusGone)
			return
		}
		allowed := false
		if r.Method == http.MethodGet {
			allowed = r.URL.Path == base || r.URL.Path == base+"/draft" || r.URL.Path == "/api/registry/services" || r.URL.Path == "/api/agent/workspace" || r.URL.Path == "/api/symbols/search" || r.URL.Path == "/api/function-body" || r.URL.Path == "/api/data-flow" || r.URL.Path == "/api/call-path" || r.URL.Path == "/api/infra" || (strings.HasPrefix(r.URL.Path, "/api/files/") && strings.HasSuffix(r.URL.Path, "/symbols"))
		} else if r.Method == http.MethodPost {
			allowed = r.URL.Path == base+"/begin" || r.URL.Path == base+"/chunks" || r.URL.Path == base+"/reset" || r.URL.Path == base+"/submit" || r.URL.Path == base+"/note" || r.URL.Path == "/api/query" || r.URL.Path == "/api/agent/presence" || r.URL.Path == "/api/agent/activity" || r.URL.Path == "/api/agent/action" || r.URL.Path == "/api/call-trace"
		}
		if !allowed {
			jsonError(w, "Mapping may only inspect this project, save mapping notes and submit its architecture. Other actions are unavailable.", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path != "/api/registry/services" && r.URL.Query().Get("workspace") != m.WorkspaceID {
			jsonError(w, "mapping must name its bound workspace", 403)
			return
		}
		for _, key := range []string{"workspace", "workspaceId"} {
			for _, value := range r.URL.Query()[key] {
				if value != m.WorkspaceID {
					jsonError(w, "mapping belongs to another workspace", http.StatusForbidden)
					return
				}
			}
		}
		if r.Method == http.MethodPost {
			body, err := io.ReadAll(io.LimitReader(r.Body, 8*1024*1024+1))
			if err != nil || len(body) > 8*1024*1024 {
				jsonError(w, "mapping request too large", http.StatusBadRequest)
				return
			}
			var payload map[string]any
			if err = json.Unmarshal(body, &payload); err != nil {
				jsonError(w, "bad mapping request", http.StatusBadRequest)
				return
			}
			if payload["workspaceId"] != m.WorkspaceID {
				jsonError(w, "mapping belongs to another workspace", http.StatusForbidden)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mappingContextKey{}, m.ID)))
	})
}

func (s *Server) handleMappingAttempts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		database, err := s.dbFor(r.URL.Query().Get("workspace"))
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		attempts, err := db.ListUnsettledMappingAttempts(database, r.URL.Query().Get("workspace"))
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, attempts)
		return
	}

	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var input struct {
		WorkspaceID string `json:"workspaceId"`
		RootID      string `json:"rootId"`
		MessageID   string `json:"messageId"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		jsonError(w, "bad request", 400)
		return
	}
	sqlDB, err := s.dbFor(input.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	secret, hash, err := mappingSecret()
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	m, err := db.StartMappingAttempt(sqlDB, input.WorkspaceID, input.RootID, uuid.NewString(), input.MessageID, hash)
	if err != nil {
		jsonError(w, err.Error(), 409)
		return
	}
	jsonOK(w, map[string]any{"attempt": m, "token": mappingToken(m.WorkspaceID, m.ID, secret)})
}

func (s *Server) handleMappingAttempt(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/mapping-attempts/"), "/")
	if len(parts) > 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	id := parts[0]
	op := ""
	if len(parts) == 2 {
		op = parts[1]
	}
	var input struct {
		WorkspaceID string           `json:"workspaceId"`
		SessionID   string           `json:"sessionId"`
		ChunkID     string           `json:"chunkId"`
		Systems     db.DraftSystems `json:"systems"`
		Note        string           `json:"note"`
		Rationale   string           `json:"rationale"`
	}
	input.WorkspaceID = r.URL.Query().Get("workspace")
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
	}
	sqlDB, err := s.dbFor(input.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	m, err := db.GetMappingAttempt(sqlDB, input.WorkspaceID, id)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if scoped, _ := r.Context().Value(mappingContextKey{}).(string); scoped != "" && scoped != id {
		jsonError(w, "mapping attempt mismatch", 403)
		return
	}
	if r.Method == http.MethodGet && op == "draft" {
		draft, e := db.GetArchitectureProposalDraft(sqlDB, id, input.WorkspaceID)
		if e != nil {
			jsonError(w, e.Error(), 404)
			return
		}
		jsonOK(w, draft)
		return
	}
	if r.Method == http.MethodGet && op == "" {
		jsonOK(w, m)
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	switch op {
	case "credentials":
		secret, hash, secretErr := mappingSecret()
		err = secretErr
		if err == nil {
			var changed int64
			result, updateErr := sqlDB.Exec(`UPDATE mapping_attempts SET token_hash=? WHERE workspace_id=? AND id=? AND state='mapping' AND ended_at=0`, hash, input.WorkspaceID, id)
			err = updateErr
			if err == nil {
				changed, err = result.RowsAffected()
			}
			if err == nil && changed != 1 {
				err = fmt.Errorf("mapping is permanently closed")
			}
		}
		if err == nil {
			jsonOK(w, map[string]any{"attempt": m, "token": mappingToken(m.WorkspaceID, id, secret)})
			return
		}
	case "cancel", "settle":
		m, err = db.EndMappingAttempt(sqlDB, input.WorkspaceID, id, op == "settle")
		if err == nil {
			s.hub.Broadcast("mapping:attempt", m)
			jsonOK(w, m)
			return
		}
	case "note", "begin":
		err = db.NoteMappingAttempt(sqlDB, input.WorkspaceID, id, input.Note, input.Rationale)
		if err == nil {
			draft, e := db.GetArchitectureProposalDraft(sqlDB, id, input.WorkspaceID)
			err = e
			if err == nil {
				jsonOK(w, draft)
				return
			}
		}
	case "reset":
		err = db.ResetMappingDraft(sqlDB, input.WorkspaceID, id)
		if err == nil {
			draft, e := db.GetArchitectureProposalDraft(sqlDB, id, input.WorkspaceID)
			err = e
			if err == nil {
				jsonOK(w, draft)
				return
			}
		}
	case "chunks":
		if input.SessionID != id {
			err = fmt.Errorf("chunk belongs to another mapping attempt")
			break
		}
		draft, e := db.AddArchitectureProposalDraftChunk(sqlDB, id, input.WorkspaceID, input.ChunkID, input.Systems)
		err = e
		if err == nil {
			jsonOK(w, draft)
			return
		}
	case "submit":
		proposal, e := db.CommitArchitectureProposalDraft(sqlDB, id, input.WorkspaceID)
		err = e
		if err == nil {
			s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": input.WorkspaceID, "proposalId": proposal.ID, "mappingAttemptId": id})
			s.hub.Broadcast("mapping:attempt", map[string]any{"workspaceId": input.WorkspaceID, "id": id, "state": "submitted"})
			jsonOK(w, proposal)
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	jsonError(w, err.Error(), http.StatusConflict)
}
