package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"ambio.local/archd/internal/db"
)

// An agent's question is held until the user answers it in the conversation,
// and an unanswered question is a refusal.
func TestAgentPermissionWaitsForTheUserAndRefusesWithoutAnAnswer(t *testing.T) {
	_, mux, _ := inboxServer(t)
	type answer struct {
		ID       string `json:"id"`
		Decision string `json:"decision"`
		Answered bool   `json:"answered"`
	}
	ask := func(body map[string]any) chan answer {
		out := make(chan answer, 1)
		go func() {
			r := inboxHTTP(t, mux, "POST", "/api/agent/permission", body)
			var got answer
			_ = json.Unmarshal(r.Body.Bytes(), &got)
			out <- got
		}()
		return out
	}
	waiting := func() []AgentPermissionRequest {
		t.Helper()
		for attempt := 0; attempt < 200; attempt++ {
			r := inboxHTTP(t, mux, "GET", "/api/agent/permission?workspace=ws", nil)
			var listed struct {
				Requests []AgentPermissionRequest `json:"requests"`
			}
			if err := json.Unmarshal(r.Body.Bytes(), &listed); err != nil {
				t.Fatal(err)
			}
			if len(listed.Requests) > 0 {
				return listed.Requests
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("the question never reached the user")
		return nil
	}

	asked := ask(map[string]any{"workspaceId": "ws", "messageId": "turn-1", "hostId": "claude-code", "title": "Run npm install", "detail": "npm install left-pad", "kind": "execute"})
	pending := waiting()
	if pending[0].Title != "Run npm install" || pending[0].MessageID != "turn-1" || pending[0].HostID != "claude-code" {
		t.Fatalf("pending = %#v", pending[0])
	}
	// Another project cannot see or answer it.
	if r := inboxHTTP(t, mux, "POST", "/api/agent/permission/decide", map[string]string{"workspaceId": "other", "id": pending[0].ID, "decision": "allow"}); r.Code != http.StatusConflict {
		t.Fatalf("another workspace answered: %d", r.Code)
	}
	if r := inboxHTTP(t, mux, "POST", "/api/agent/permission/decide", map[string]string{"workspaceId": "ws", "id": pending[0].ID, "decision": "maybe"}); r.Code != http.StatusBadRequest {
		t.Fatalf("accepted an answer that is neither allow nor deny: %d", r.Code)
	}
	if r := inboxHTTP(t, mux, "POST", "/api/agent/permission/decide", map[string]string{"workspaceId": "ws", "id": pending[0].ID, "decision": "allow"}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if got := <-asked; got.Decision != "allow" || !got.Answered {
		t.Fatalf("answer = %#v", got)
	}
	// Answering twice is refused: the agent has already gone on.
	if r := inboxHTTP(t, mux, "POST", "/api/agent/permission/decide", map[string]string{"workspaceId": "ws", "id": pending[0].ID, "decision": "deny"}); r.Code != http.StatusConflict {
		t.Fatalf("answered twice: %d", r.Code)
	}

	// Nobody answers: the agent is refused, and the question is cleared.
	if got := <-ask(map[string]any{"workspaceId": "ws", "hostId": "codex", "title": "Delete the build folder", "waitMs": 30}); got.Decision != "deny" || got.Answered {
		t.Fatalf("unanswered request = %#v", got)
	}
	r := inboxHTTP(t, mux, "GET", "/api/agent/permission?workspace=ws", nil)
	if r.Body.String() != `{"requests":[]}`+"\n" && r.Body.String() != `{"requests":[]}` {
		t.Fatalf("an expired question is still listed: %s", r.Body.String())
	}

	for _, bad := range []map[string]any{
		{"workspaceId": "ws", "title": ""},
		{"workspaceId": "", "title": "x"},
		{"workspaceId": "no-such-workspace-\x00", "title": "x"},
	} {
		if r := inboxHTTP(t, mux, "POST", "/api/agent/permission", bad); r.Code == 200 {
			t.Fatalf("accepted %v", bad)
		}
	}
}

// An agent's question is answered in the user's words or choices, and what a
// turn still has waiting is released, as a refusal, when the turn ends.
func TestAgentQuestionsTakeAnswersAndEndWithTheirTurn(t *testing.T) {
	_, mux, _ := inboxServer(t)
	type answer struct {
		Decision  string            `json:"decision"`
		Answered  bool              `json:"answered"`
		Cancelled bool              `json:"cancelled"`
		Answers   map[string]string `json:"answers"`
	}
	ask := func(body map[string]any) chan answer {
		out := make(chan answer, 1)
		go func() {
			r := inboxHTTP(t, mux, "POST", "/api/agent/permission", body)
			var got answer
			_ = json.Unmarshal(r.Body.Bytes(), &got)
			out <- got
		}()
		return out
	}
	waitingFor := func(count int) []AgentPermissionRequest {
		t.Helper()
		for attempt := 0; attempt < 200; attempt++ {
			r := inboxHTTP(t, mux, "GET", "/api/agent/permission?workspace=ws", nil)
			var listed struct {
				Requests []AgentPermissionRequest `json:"requests"`
			}
			if err := json.Unmarshal(r.Body.Bytes(), &listed); err != nil {
				t.Fatal(err)
			}
			if len(listed.Requests) == count {
				return listed.Requests
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("expected %d waiting", count)
		return nil
	}
	questions := []map[string]any{
		{"question": "Which colour?", "header": "Colour", "options": []map[string]string{{"label": "Red"}, {"label": "Blue", "description": "The sea"}}},
		{"question": "Which sizes?", "multiSelect": true, "options": []map[string]string{{"label": "S"}, {"label": "M"}}},
	}
	asked := ask(map[string]any{"workspaceId": "ws", "messageId": "turn-q", "hostId": "claude-code", "title": "Which colour?", "questions": questions})
	pending := waitingFor(1)[0]
	if pending.Kind != "question" || len(pending.Questions) != 2 || pending.Questions[0].Options[1].Description != "The sea" || !pending.Questions[1].MultiSelect {
		t.Fatalf("question = %#v", pending)
	}
	decide := func(body map[string]any) int {
		return inboxHTTP(t, mux, "POST", "/api/agent/permission/decide", body).Code
	}
	if code := decide(map[string]any{"workspaceId": "ws", "id": pending.ID, "decision": "allow"}); code != http.StatusBadRequest {
		t.Fatalf("a question was allowed instead of answered: %d", code)
	}
	if code := decide(map[string]any{"workspaceId": "ws", "id": pending.ID, "decision": "answer", "answers": map[string]string{"Which colour?": "Blue"}}); code != http.StatusBadRequest {
		t.Fatalf("a question went unanswered: %d", code)
	}
	if code := decide(map[string]any{"workspaceId": "ws", "id": pending.ID, "decision": "answer", "answers": map[string]string{"Which colour?": " Teal, actually ", "Which sizes?": "S, M"}}); code != 200 {
		t.Fatal(code)
	}
	if got := <-asked; got.Decision != "answer" || !got.Answered || got.Answers["Which colour?"] != "Teal, actually" || got.Answers["Which sizes?"] != "S, M" {
		t.Fatalf("answer = %#v", got)
	}

	// A permission request is not answered in words.
	permission := ask(map[string]any{"workspaceId": "ws", "messageId": "turn-q", "hostId": "claude-code", "title": "Use Bash"})
	other := ask(map[string]any{"workspaceId": "ws", "messageId": "turn-other", "hostId": "codex", "title": "Use Bash"})
	both := waitingFor(2)
	for _, request := range both {
		if request.MessageID == "turn-q" {
			if code := decide(map[string]any{"workspaceId": "ws", "id": request.ID, "decision": "answer", "answers": map[string]string{}}); code != http.StatusBadRequest {
				t.Fatalf("a permission request took an answer: %d", code)
			}
		}
	}
	// The turn ends: what it still has waiting is refused, the other turn's stays.
	r := inboxHTTP(t, mux, "POST", "/api/agent/permission/cancel", map[string]string{"workspaceId": "ws", "messageId": "turn-q"})
	if r.Code != 200 || r.Body.String() != `{"cancelled":1}`+"\n" && r.Body.String() != `{"cancelled":1}` {
		t.Fatal(r.Code, r.Body.String())
	}
	if got := <-permission; got.Decision != "deny" || got.Answered || !got.Cancelled {
		t.Fatalf("cancelled = %#v", got)
	}
	if left := waitingFor(1); left[0].MessageID != "turn-other" {
		t.Fatalf("another turn's question was released: %#v", left)
	}
	if code := inboxHTTP(t, mux, "POST", "/api/agent/permission/cancel", map[string]string{"workspaceId": "ws"}).Code; code != http.StatusBadRequest {
		t.Fatalf("cancelled without naming a turn: %d", code)
	}
	inboxHTTP(t, mux, "POST", "/api/agent/permission/cancel", map[string]string{"workspaceId": "ws", "messageId": "turn-other"})
	<-other

	for _, bad := range [][]map[string]any{
		{{"question": ""}},
		{{"question": "Same?"}, {"question": "Same?"}},
		{{"question": "Choice?", "options": []map[string]string{{"label": " "}}}},
	} {
		if r := inboxHTTP(t, mux, "POST", "/api/agent/permission", map[string]any{"workspaceId": "ws", "title": "x", "questions": bad}); r.Code != http.StatusBadRequest {
			t.Fatalf("accepted questions %v: %d", bad, r.Code)
		}
	}
}

// An open turn left for one host's watching session is not picked up by a
// session of another host that happens to check the inbox.
func TestOpenTurnForOneHostIsNotClaimedByAnother(t *testing.T) {
	_, mux, _ := inboxServer(t)
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"id": "for-cursor", "workspaceId": "ws", "deliveryMode": "open", "targetHost": "cursor", "note": "Continue here."}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	claim := func(agent string) []db.InboxItem {
		t.Helper()
		r := inboxHTTP(t, mux, "POST", "/api/canvas/claim", map[string]string{"workspaceId": "ws", "connectionId": "conn-" + agent, "agent": agent})
		var result struct {
			Messages []db.InboxItem `json:"messages"`
		}
		if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil {
			t.Fatal(r.Body.String(), err)
		}
		return result.Messages
	}
	if got := claim("codex"); len(got) != 0 {
		t.Fatalf("another host took a turn left for Cursor: %#v", got)
	}
	got := claim("cursor")
	if len(got) != 1 || got[0].ID != "for-cursor" || got[0].TargetHost != "cursor" {
		t.Fatalf("the watching Cursor session did not get its turn: %#v", got)
	}
	// An open turn with no host named is still for any session.
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"id": "for-anyone", "workspaceId": "ws", "deliveryMode": "open", "note": "Whoever is watching."}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if got := claim("codex"); len(got) != 1 || got[0].ID != "for-anyone" {
		t.Fatalf("an untargeted open turn was not claimable: %#v", got)
	}
}
