package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func infraServer(t *testing.T) *Server {
	t.Helper()
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "harbor"}); err != nil {
		t.Fatal(err)
	}
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"repo", "bus"} {
		if err := db.UpsertFile(sqlDB, db.File{ID: id, RootID: "root", Path: id + ".ts", RelPath: id + ".ts", Language: "typescript"}); err != nil {
			t.Fatal(err)
		}
	}
	return server
}

func call(t *testing.T, handler http.HandlerFunc, method, path string, body any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(method, path, bytes.NewReader(raw)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestAnInProcessRoleIsRecordedWithItsContractAndUsers(t *testing.T) {
	server := infraServer(t)
	code, bus := call(t, server.handleInfra, "POST", "/api/infra", map[string]any{
		"workspaceId": "ws", "service": "generic/queue", "name": "Event bus",
	})
	if code != 200 {
		t.Fatalf("create: %d %v", code, bus)
	}
	id := bus["id"].(string)

	code, out := call(t, server.handleInfraByID, "PUT", "/api/infra/"+id, map[string]any{
		"workspaceId": "ws",
		"implementations": []map[string]any{{"environment": "local", "kind": "in-process", "ref": "bus.ts"}},
		"policies": map[string]any{"never_in_tests": false},
	})
	if code != 200 {
		t.Fatalf("implementations: %d %v", code, out)
	}
	if code, out = call(t, server.handleInfraByID, "PUT", "/api/infra/"+id, map[string]any{
		"workspaceId":     "ws",
		"implementations": []map[string]any{{"environment": "local", "kind": "magic", "ref": "bus.ts"}},
	}); code != 400 {
		t.Fatalf("an unknown implementation kind is refused: %d %v", code, out)
	}

	if code, out = call(t, server.handleInfraByID, "POST", "/api/infra/"+id+"/contents", map[string]any{
		"workspaceId": "ws", "source": "agent",
		"items": []map[string]any{{"kind": "topic", "name": "booking.confirmed", "evidence": "src/events/topics.ts:3"}},
	}); code != 200 {
		t.Fatalf("contents: %d %v", code, out)
	}
	if code, out = call(t, server.handleInfraByID, "POST", "/api/infra/"+id+"/contents", map[string]any{
		"workspaceId": "ws", "items": []map[string]any{{"kind": "column", "name": "x"}},
	}); code != 400 {
		t.Fatalf("an unknown contents kind is refused: %d %v", code, out)
	}

	for _, rel := range []map[string]any{
		{"srcId": "bus", "kind": "IMPLEMENTS"},
		{"srcId": "repo", "kind": "PUBLISHES", "targetItem": "booking.confirmed", "status": "proposed"},
	} {
		body := map[string]any{"workspaceId": "ws", "srcType": "file", "infraId": id}
		for k, v := range rel {
			body[k] = v
		}
		if code, out = call(t, server.handleInfraConnect, "POST", "/api/infra/connect", body); code != 200 {
			t.Fatalf("connect %v: %d %v", rel, code, out)
		}
	}
	if code, out = call(t, server.handleInfraConnect, "POST", "/api/infra/connect", map[string]any{
		"workspaceId": "ws", "srcId": "repo", "srcType": "file", "infraId": id, "kind": "READS",
	}); code != 400 {
		t.Fatalf("a queue has no readers: %d %v", code, out)
	}

	if code, out = call(t, server.handleInfraByID, "POST", "/api/infra/requirements", map[string]any{
		"workspaceId": "ws", "items": []map[string]any{{"kind": "env", "name": "REDIS_URL", "infraId": id}},
	}); code != 200 {
		t.Fatalf("requirements: %d %v", code, out)
	}

	rec := httptest.NewRecorder()
	server.handleInfra(rec, httptest.NewRequest("GET", "/api/infra?workspace=ws", nil))
	var listed struct {
		Nodes        []db.InfraNode        `json:"nodes"`
		Edges        []db.Dependency       `json:"edges"`
		Contents     []db.InfraContent     `json:"contents"`
		Requirements []db.InfraRequirement `json:"requirements"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Nodes) != 1 || len(listed.Nodes[0].Implementations) == 0 {
		t.Fatalf("the node carries its implementation: %+v", listed.Nodes)
	}
	if len(listed.Contents) != 1 || listed.Contents[0].Name != "booking.confirmed" {
		t.Fatalf("the contract: %+v", listed.Contents)
	}
	if len(listed.Requirements) != 1 || listed.Requirements[0].Name != "REDIS_URL" {
		t.Fatalf("requirements: %+v", listed.Requirements)
	}
	var publish db.Dependency
	for _, e := range listed.Edges {
		if e.DependencyType == "PUBLISHES" {
			publish = e
		}
	}
	if publish.TargetItem != "booking.confirmed" || publish.Status != "proposed" {
		t.Fatalf("the edge names its topic and is a proposal: %+v", publish)
	}

	if code, out = call(t, server.handleInfraEdge, "PUT", "/api/infra/edge/"+publish.ID, map[string]any{
		"workspaceId": "ws", "status": "confirmed",
	}); code != 200 {
		t.Fatalf("confirm: %d %v", code, out)
	}
}
