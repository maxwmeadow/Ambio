package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func inboxServer(t *testing.T) (*Server, *http.ServeMux, string) {
	t.Helper()
	h := hub.New()
	s := NewServer(t.TempDir(), h, axiomruntime.NewManager(h))
	d, err := s.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	root := t.TempDir()
	if err = db.UpsertWorkspace(d, db.Workspace{ID: "ws", Name: "Workspace"}); err != nil {
		t.Fatal(err)
	}
	if err = db.UpsertRoot(d, db.Root{ID: "root", WorkspaceID: "ws", Path: root, IsActive: true, IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	if err = db.UpsertFile(d, db.File{ID: "file", RootID: "root", Path: filepath.Join(root, "hello.go"), RelPath: "hello.go", Language: "go"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)
	return s, mux, root
}
func inboxHTTP(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
func TestInboxHTTPLifecycle(t *testing.T) {
	s, mux, _ := inboxServer(t)
	send := map[string]any{"id": "request", "workspaceId": "ws", "note": "Review file", "selection": "[\"axiom://file/file?label=hello.go\"]"}
	for i := 0; i < 2; i++ {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/send", send)
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	// Legacy GET and prompt previews must never consume instructions.
	for i := 0; i < 2; i++ {
		r := inboxHTTP(t, mux, "GET", "/api/canvas/outbox?workspace=ws", nil)
		if !strings.Contains(r.Body.String(), "request") {
			t.Fatal(r.Body.String())
		}
	}
	claim := inboxHTTP(t, mux, "POST", "/api/canvas/claim", map[string]string{"workspaceId": "ws", "connectionId": "agent-a", "agent": "A"})
	var result struct {
		Messages []db.InboxItem `json:"messages"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &result); err != nil || len(result.Messages) != 1 {
		t.Fatal(claim.Body.String(), err)
	}
	item := result.Messages[0]
	history := inboxHTTP(t, mux, "GET", "/api/canvas/history?workspace=ws", nil)
	if strings.Contains(history.Body.String(), item.LeaseToken) {
		t.Fatal("history leaked claim credential")
	}
	reply := map[string]string{"workspaceId": "ws", "msgId": item.ID, "leaseToken": item.LeaseToken, "body": "Here is the answer"}
	for i := 0; i < 2; i++ {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", reply)
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	reply["body"] = "changed"
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", reply); r.Code != 409 {
		t.Fatal(r.Code)
	}
	// Lost send acknowledgement remains retryable after selected objects disappear.
	d, _ := s.dbFor("ws")
	if _, err := d.Exec(`DELETE FROM files WHERE id='file'`); err != nil {
		t.Fatal(err)
	}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", send); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
}
func TestInboxRejectsInvalidBodiesAndForeignTargets(t *testing.T) {
	_, mux, _ := inboxServer(t)
	for _, body := range []map[string]any{
		{"workspaceId": "ws", "note": "   "},
		{"workspaceId": "ws", "note": strings.Repeat("x", 16001)},
		{"workspaceId": "ws", "note": "valid", "selection": "{}"},
		{"workspaceId": "ws", "note": "valid", "selection": "null"},
		{"workspaceId": "ws", "note": "valid", "selection": "[\"axiom://file/foreign\"]"},
		{"workspaceId": "ws", "note": "valid", "status": "answered"},
		{"workspaceId": "../outside", "note": "valid"},
	} {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/send", body)
		if r.Code < 400 || r.Code >= 500 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
}

func TestInboxHistoryCountsPendingOutsideLoadedPage(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	for _, item := range []struct {
		id, status string
		created    int
	}{
		{"older-pending", "queued", 1},
		{"newer-cancelled", "cancelled", 2},
	} {
		if _, err := d.Exec(`INSERT INTO canvas_outbox(id,workspace_id,note,selection,status,created_at) VALUES(?, 'ws', 'Instruction', '[]', ?, ?)`, item.id, item.status, item.created); err != nil {
			t.Fatal(err)
		}
	}
	r := inboxHTTP(t, mux, "GET", "/api/canvas/history?workspace=ws&limit=1", nil)
	var result struct {
		Messages       []db.InboxItem `json:"messages"`
		AvailableCount int            `json:"availableCount"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil || r.Code != 200 {
		t.Fatal(r.Code, r.Body.String(), err)
	}
	if len(result.Messages) != 1 || result.Messages[0].ID != "newer-cancelled" || result.AvailableCount != 1 {
		t.Fatal(r.Body.String())
	}
}
func TestAgentWorkspaceUsesPersistedRootsAndExplicitBinding(t *testing.T) {
	_, mux, root := inboxServer(t)
	r := inboxHTTP(t, mux, "GET", "/api/agent/workspace?cwd="+root, nil)
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"workspaceId":"ws"`) {
		t.Fatal(r.Code, r.Body.String())
	}
	r = inboxHTTP(t, mux, "GET", "/api/agent/workspace?cwd=/unrelated", nil)
	if r.Code != 404 {
		t.Fatal(r.Code)
	}
	r = inboxHTTP(t, mux, "GET", "/api/agent/workspace?cwd=/unrelated&workspace=ws", nil)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
}
func TestLocalTokenProtectsHTTPAndWebsocket(t *testing.T) {
	_, mux, _ := inboxServer(t)
	token := "01234567890123456789012345678901"
	handler := AllowAuthenticatedOrigins(RequireLocalToken(token, mux))
	for _, path := range []string{"/api/canvas/history?workspace=ws", "/ws?workspace=ws"} {
		r := inboxHTTP(t, handler, "GET", path, nil)
		if r.Code != 401 {
			t.Fatal(r.Code)
		}
	}
	req := httptest.NewRequest("GET", "/api/canvas/history?workspace=ws", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "null")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatal("packaged renderer cannot read authenticated response")
	}
	dir := t.TempDir()
	first, err := LocalAPIToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LocalAPIToken(dir)
	if err != nil || first != second {
		t.Fatal("token changed across restart", err)
	}
}
