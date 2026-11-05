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
// An agent can also ask the user something (Claude Code's AskUserQuestion):
// the request then carries its questions and is answered with the user's
// choices or own words instead of allow, or refused.
//
// A question belongs to its turn. When the turn ends, the runner releases
// whatever that turn still has waiting (cancel), and each is a refusal.
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
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
	Kind   string `json:"kind,omitempty"`
	// Questions, when present, make this a question rather than a request
	// for permission (Kind "question").
	Questions []AgentQuestion `json:"questions,omitempty"`
	AskedAt   int64           `json:"askedAt"`
	ExpiresAt int64           `json:"expiresAt"`
}

// AgentQuestion is one thing an agent asks the user, with the choices it
// offers. The user may pick or write their own answer.
type AgentQuestion struct {
	Question    string                `json:"question"`
	Header      string                `json:"header,omitempty"`
	Options     []AgentQuestionOption `json:"options,omitempty"`
	MultiSelect bool                  `json:"multiSelect,omitempty"`
}

// AgentQuestionOption is one offered answer.
type AgentQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type permissionAnswer struct {
	decision string
	// answers maps each question's text to the user's answer.
	answers map[string]string
	// cancelled: the turn ended before the user answered.
	cancelled bool
}

type pendingPermission struct {
	request AgentPermissionRequest
	answer  chan permissionAnswer
}

type permissionDesk struct {
	mu      sync.Mutex
	pending map[string]*pendingPermission
}

const (
	permissionWaitDefault = 110 * time.Second
	permissionWaitMax     = 10 * time.Minute
	maxQuestions          = 8
	maxQuestionOptions    = 12
	maxAnswerLength       = 4000
)

func (d *permissionDesk) add(entry *pendingPermission) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pending == nil {
		d.pending = map[string]*pendingPermission{}
	}
	d.pending[entry.request.ID] = entry
}

func (d *permissionDesk) get(workspaceID, id string) *pendingPermission {
	d.mu.Lock()
	defer d.mu.Unlock()
	entry := d.pending[id]
	if entry == nil || entry.request.WorkspaceID != workspaceID {
		return nil
	}
	return entry
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

// takeTurn removes everything one turn still has waiting.
func (d *permissionDesk) takeTurn(workspaceID, messageID string) []*pendingPermission {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []*pendingPermission{}
	for id, entry := range d.pending {
		if entry.request.WorkspaceID == workspaceID && entry.request.MessageID == messageID {
			delete(d.pending, id)
			out = append(out, entry)
		}
	}
	return out
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
	mux.HandleFunc("/api/agent/permission/cancel", s.handleAgentPermissionCancel)
}

// validQuestions reports whether an agent's questions are ones the
// conversation can show: each asks something distinct, and choices are short.
func validQuestions(questions []AgentQuestion) bool {
	if len(questions) > maxQuestions {
		return false
	}
	seen := map[string]bool{}
	for _, question := range questions {
		if strings.TrimSpace(question.Question) == "" || len(question.Question) > 1000 || len(question.Header) > 120 ||
			len(question.Options) > maxQuestionOptions || seen[question.Question] {
			return false
		}
		seen[question.Question] = true
		for _, option := range question.Options {
			if strings.TrimSpace(option.Label) == "" || len(option.Label) > 200 || len(option.Description) > 1000 {
				return false
			}
		}
	}
	return true
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
			WorkspaceID string          `json:"workspaceId"`
			MessageID   string          `json:"messageId"`
			HostID      string          `json:"hostId"`
			Title       string          `json:"title"`
			Detail      string          `json:"detail"`
			Kind        string          `json:"kind"`
			Questions   []AgentQuestion `json:"questions"`
			WaitMs      int64           `json:"waitMs"`
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
		if !validQuestions(body.Questions) {
			jsonError(w, "each question needs its own text and short choices", http.StatusBadRequest)
			return
		}
		if len(body.Questions) > 0 {
			body.Kind = "question"
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
				Title: body.Title, Detail: body.Detail, Kind: body.Kind, Questions: body.Questions,
				AskedAt: now.UnixMilli(), ExpiresAt: now.Add(wait).UnixMilli(),
			},
			answer: make(chan permissionAnswer, 1),
		}
		s.permissions.add(entry)
		s.broadcastPatch("agent:permission", entry.request, body.WorkspaceID)

		got, received := permissionAnswer{decision: "deny"}, false
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case got = <-entry.answer:
			received = true
		case <-timer.C:
		case <-r.Context().Done():
			// The agent went away; its question goes with it.
		}
		if !received {
			s.permissions.take(body.WorkspaceID, entry.request.ID)
			s.broadcastPatch("agent:permission-resolved", map[string]any{"workspaceId": body.WorkspaceID, "id": entry.request.ID, "decision": "expired"}, body.WorkspaceID)
		}
		out := map[string]any{"id": entry.request.ID, "decision": got.decision, "answered": received && !got.cancelled}
		if got.cancelled {
			out["cancelled"] = true
		}
		if got.answers != nil {
			out["answers"] = got.answers
		}
		jsonOK(w, out)

	default:
		http.NotFound(w, r)
	}
}

// handleAgentPermissionDecide records the user's answer and releases the agent.
// A permission request takes allow or deny; a question takes answer (with an
// answer to every question) or deny.
func (s *Server) handleAgentPermissionDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string            `json:"workspaceId"`
		ID          string            `json:"id"`
		Decision    string            `json:"decision"`
		Answers     map[string]string `json:"answers"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" || body.ID == "" ||
		(body.Decision != "allow" && body.Decision != "deny" && body.Decision != "answer") {
		jsonError(w, "workspaceId, id and a decision of allow, answer or deny are required", http.StatusBadRequest)
		return
	}
	waiting := s.permissions.get(body.WorkspaceID, body.ID)
	if waiting == nil {
		// Already answered, or the agent stopped waiting.
		jsonError(w, "this request is no longer waiting", http.StatusConflict)
		return
	}
	asking := len(waiting.request.Questions) > 0
	answer := permissionAnswer{decision: body.Decision}
	switch {
	case asking && body.Decision == "allow":
		jsonError(w, "a question is answered, not allowed", http.StatusBadRequest)
		return
	case !asking && body.Decision == "answer":
		jsonError(w, "this request asks for permission, not an answer", http.StatusBadRequest)
		return
	case body.Decision == "answer":
		answer.answers = map[string]string{}
		for _, question := range waiting.request.Questions {
			text := strings.TrimSpace(body.Answers[question.Question])
			if text == "" || len(text) > maxAnswerLength {
				jsonError(w, "answer every question, briefly", http.StatusBadRequest)
				return
			}
			answer.answers[question.Question] = text
		}
	}
	entry := s.permissions.take(body.WorkspaceID, body.ID)
	if entry == nil {
		jsonError(w, "this request is no longer waiting", http.StatusConflict)
		return
	}
	entry.answer <- answer
	s.broadcastPatch("agent:permission-resolved", map[string]any{"workspaceId": body.WorkspaceID, "id": body.ID, "decision": body.Decision}, body.WorkspaceID)
	jsonOK(w, map[string]any{"id": body.ID, "decision": body.Decision})
}

// handleAgentPermissionCancel releases everything a turn still has waiting,
// once that turn has ended: each is a refusal, and its card goes away.
func (s *Server) handleAgentPermissionCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		MessageID   string `json:"messageId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" || body.MessageID == "" {
		jsonError(w, "workspaceId and messageId are required", http.StatusBadRequest)
		return
	}
	released := s.permissions.takeTurn(body.WorkspaceID, body.MessageID)
	for _, entry := range released {
		entry.answer <- permissionAnswer{decision: "deny", cancelled: true}
		s.broadcastPatch("agent:permission-resolved", map[string]any{"workspaceId": body.WorkspaceID, "id": entry.request.ID, "decision": "cancelled"}, body.WorkspaceID)
	}
	jsonOK(w, map[string]any{"cancelled": len(released)})
}
