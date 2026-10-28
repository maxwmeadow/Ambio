package api

import (
	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	ambioruntime "ambio.local/archd/internal/runtime"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMappingCredentialOnlyMapsItsProjectAndDiesAtCommit(t *testing.T) {
	h := hub.New()
	s := NewServer(t.TempDir(), h, ambioruntime.NewManager(h))
	d, err := s.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeDB("ws") })
	for _, err := range []error{db.UpsertWorkspace(d, db.Workspace{ID: "ws", Name: "mapping"}), db.UpsertRoot(d, db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}), db.UpsertFile(d, db.File{ID: "a", RootID: "root", Path: "a.go", RelPath: "a.go", Language: "go"})} {
		if err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)
	handler := s.RequireAPIToken("desktop-secret", mux)
	request := func(token, method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	create := request("desktop-secret", "POST", "/api/mapping-attempts", map[string]any{"workspaceId": "ws"})
	if create.Code != 200 {
		t.Fatal(create.Body.String())
	}
	var binding struct {
		Attempt db.MappingAttempt `json:"attempt"`
		Token   string            `json:"token"`
	}
	json.Unmarshal(create.Body.Bytes(), &binding)
	base := "/api/mapping-attempts/" + binding.Attempt.ID
	for _, path := range []string{"/api/architecture/edits", "/api/work/start", "/api/canvas/reply", "/api/architecture-proposals", "/api/sheets", "/api/infra"} {
		if w := request(binding.Token, "POST", path, map[string]any{"workspaceId": "ws"}); w.Code != 403 {
			t.Fatalf("mapping capability escaped to %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	if w := request(binding.Token, "POST", "/api/query", map[string]any{"workspaceId": "other", "sql": "SELECT 1"}); w.Code != 403 {
		t.Fatal("cross-workspace read accepted")
	}
	if w := request(binding.Token, "POST", base+"/note", map[string]any{"workspaceId": "ws", "note": "Before commit"}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	// A misnamed key is refused when the chunk arrives, naming the key, rather
	// than stored as a system that owns nothing and failing only at submit.
	w := request(binding.Token, "POST", base+"/chunks", map[string]any{"workspaceId": "ws", "sessionId": binding.Attempt.ID, "chunkId": "one", "systems": []map[string]any{{"systemKey": "a", "name": "A", "filePaths": []string{"a.go"}}}})
	if w.Code != 400 || !bytes.Contains(w.Body.Bytes(), []byte(`filePaths`)) {
		t.Fatalf("unknown system key accepted: %d %s", w.Code, w.Body.String())
	}
	// A map the agent wants to redo starts over without leaving the attempt.
	w = request(binding.Token, "POST", base+"/chunks", map[string]any{"workspaceId": "ws", "sessionId": binding.Attempt.ID, "chunkId": "one", "systems": []db.DraftSystem{{SystemKey: "wrong", Name: "Wrong", Files: []string{"a.go"}}}})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = request(binding.Token, "POST", base+"/reset", map[string]any{"workspaceId": "ws"}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = request(binding.Token, "POST", base+"/chunks", map[string]any{"workspaceId": "ws", "sessionId": binding.Attempt.ID, "chunkId": "one", "systems": []db.DraftSystem{{SystemKey: "a", Name: "A", Files: []string{"a.go"}}}})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = request(binding.Token, "POST", base+"/submit", map[string]any{"workspaceId": "ws"})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var submitted db.ArchitectureProposal
	json.Unmarshal(w.Body.Bytes(), &submitted)
	if len(submitted.Round.Systems) != 1 || submitted.Round.Systems[0].SystemKey != "a" {
		t.Fatalf("reset left the earlier map behind: %#v", submitted.Round.Systems)
	}
	for _, call := range []struct{ method, path string }{{"GET", base + "?workspace=ws"}, {"POST", base + "/note"}, {"POST", "/api/query"}, {"POST", "/api/work/start"}} {
		if w := request(binding.Token, call.method, call.path, map[string]any{"workspaceId": "ws", "note": "Late"}); w.Code != 410 {
			t.Fatalf("late call succeeded: %s %s: %d", call.method, call.path, w.Code)
		}
	}
	if w := request(binding.Token, "POST", base+"/submit", map[string]any{"workspaceId": "ws"}); w.Code != 200 {
		t.Fatal("transport replay was not safe", w.Body.String())
	}
	if w := request("desktop-secret", "POST", base+"/settle", map[string]any{"workspaceId": "ws"}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
}
