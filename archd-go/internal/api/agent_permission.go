package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// An agent Ambio started sometimes wants to do something its turn did not
// already allow: a shell command outside the listed checks, say. Nobody is at
// that agent's keyboard, so the question comes here and is put to the user in
// the conversation. The asking request is held open until the user answers or
// the wait runs out; an unanswered question is a refusal, never a yes.
//
// Requests live in memory only. A daemon restart drops them, and the agent,
// whose held request then fails, is refused: the safe direction.

// AgentPermissionRequest is one question waiting for the user.
type AgentPermissionRequest struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	// MessageID is the turn the agent is working on, when known.
	MessageID string `json:"messageId,omitempty"`
	HostID    string `json:"hostId"`
	// Title is what the agent wants to do, in a few words; Detail is the
	// command, path or input in full.
	Title     string `json:"title"`
	Detail    string `json:"detail,omitempty"`
	Kind      string `json:"kind,omitempty"`
	AskedAt   int64  `json:"askedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

type pendingPermission struct {
	request AgentPermissionRequest
	answer  chan string
}

type permissionDesk struct {
	mu      sync.Mutex
	pending map[string]*pendingPermission
}

const (
	permissionWaitDefault = 110 * time.Second
	permissionWaitMax     = 10 * time.Minute
)

func (d *permissionDesk) add(entry *pendingPermission) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pending == nil {
		d.pending = map[string]*pendingPermission{}
	}
	d.pending[entry.request.ID] = entry
}

func (d *permissionDesk) take(workspaceID, id string) *pendingPermission {
	d.mu.Lock()
	defer d.mu.Unlock()
	entry := d.pending[id]
	if entry == nil || entry.request.WorkspaceID != workspaceID {
		return nil
	}
	delete(d.pending, id)
	return entry
}

func (d *permissionDesk) list(workspaceID string) []AgentPermissionRequest {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []AgentPermissionRequest{}
	for _, entry := range d.pending {
		if entry.request.WorkspaceID == workspaceID {
			out = append(out, entry.request)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AskedAt < out[j].AskedAt })
	return out
}

func (s *Server) registerPermissionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/agent/permission", s.handleAgentPermission)
	mux.HandleFunc("/api/agent/permission/decide", s.handleAgentPermissionDecide)
}

// handleAgentPermission: POST asks and waits for the answer; GET lists what
// is waiting in a workspace.
func (s *Server) handleAgentPermission(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		if workspaceID == "" {
			jsonError(w, "workspace is required", http.StatusBadRequest)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		jsonOK(w, map[string]any{"requests": s.permissions.list(workspaceID)})

	case http.MethodPost:
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			MessageID   string `json:"messageId"`
			HostID      string `json:"hostId"`
			Title       string `json:"title"`
			Detail      string `json:"detail"`
			Kind        string `json:"kind"`
			WaitMs      int64  `json:"waitMs"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "invalid or oversized permission request", http.StatusBadRequest)
			return
		}
		body.Title = strings.TrimSpace(body.Title)
		if body.WorkspaceID == "" || body.Title == "" || len(body.Title) > 400 || len(body.Detail) > 8000 ||
			len(body.MessageID) > 128 || len(body.HostID) > 128 || len(body.Kind) > 64 {
			jsonError(w, "workspaceId and a short title are required", http.StatusBadRequest)
			return
		}
		if _, err := s.dbFor(body.WorkspaceID); err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		wait := permissionWaitDefault
		if body.WaitMs > 0 {
			wait = time.Duration(body.WaitMs) * time.Millisecond
			if wait > permissionWaitMax {
				wait = permissionWaitMax
			}
		}
		if body.HostID == "" {
			body.HostID = "unknown"
		}
		now := time.Now()
		entry := &pendingPermission{
			request: AgentPermissionRequest{
				ID: uuid.NewString(), WorkspaceID: body.WorkspaceID, MessageID: body.MessageID, HostID: body.HostID,
				Title: body.Title, Detail: body.Detail, Kind: body.Kind,
				AskedAt: now.UnixMilli(), ExpiresAt: now.Add(wait).UnixMilli(),
			},
			answer: make(chan string, 1),
		}
		s.permissions.add(entry)
		s.broadcastPatch("agent:permission", entry.request, body.WorkspaceID)

		decision, answered := "deny", false
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case decision = <-entry.answer:
			answered = true
		case <-timer.C:
		case <-r.Context().Done():
			// The agent went away; its question goes with it.
		}
		if !answered {
			s.permissions.take(body.WorkspaceID, entry.request.ID)
			s.broadcastPatch("agent:permission-resolved", map[string]any{"workspaceId": body.WorkspaceID, "id": entry.request.ID, "decision": "expired"}, body.WorkspaceID)
		}
		jsonOK(w, map[string]any{"id": entry.request.ID, "decision": decision, "answered": answered})

	default:
		http.NotFound(w, r)
	}
}

// handleAgentPermissionDecide records the user's answer and releases the agent.
func (s *Server) handleAgentPermissionDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		ID          string `json:"id"`
		Decision    string `json:"decision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" || body.ID == "" ||
		(body.Decision != "allow" && body.Decision != "deny") {
		jsonError(w, "workspaceId, id and a decision of allow or deny are required", http.StatusBadRequest)
		return
	}
	entry := s.permissions.take(body.WorkspaceID, body.ID)
	if entry == nil {
		// Already answered, or the agent stopped waiting.
		jsonError(w, "this request is no longer waiting", http.StatusConflict)
		return
	}
	entry.answer <- body.Decision
	s.broadcastPatch("agent:permission-resolved", map[string]any{"workspaceId": body.WorkspaceID, "id": body.ID, "decision": body.Decision}, body.WorkspaceID)
	jsonOK(w, map[string]any{"id": body.ID, "decision": body.Decision})
}
