package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

func meaningServer(t *testing.T) *Server {
	t.Helper()
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, runtime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	for _, step := range []error{
		db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}),
		db.UpsertRoot(sqlDB, db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}),
		db.UpsertSystem(sqlDB, db.System{ID: "orders", WorkspaceID: "ws", Name: "Orders", Source: "user"}),
		db.UpsertSystem(sqlDB, db.System{ID: "payments", WorkspaceID: "ws", Name: "Payments", Source: "user"}),
		db.UpsertFile(sqlDB, db.File{ID: "billing", RootID: "root", Path: "/s/billing.ts", RelPath: "billing.ts", Language: "typescript"}),
	} {
		if step != nil {
			t.Fatal(step)
		}
	}
	return server
}

func send(t *testing.T, server *Server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, _ := json.Marshal(body)
	recorder := httptest.NewRecorder()
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)
	mux.ServeHTTP(recorder, httptest.NewRequest(method, path, bytes.NewReader(encoded)))
	return recorder
}

func eventsIn(t *testing.T, server *Server) []db.StructuralEvent {
	t.Helper()
	events, err := db.GetStructuralEvents(mustDB(t, server), "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func TestArchitectureEditsEndpointRecordsTheActor(t *testing.T) {
	server := meaningServer(t)
	recorder := send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws",
		"actor":       map[string]any{"kind": "agent", "agent": "claude-code"},
		"edits": []map[string]any{
			{"op": "assign", "fileIds": []string{"billing"}, "systemId": "payments"},
			{"op": "rename", "systemId": "payments", "name": "Billing"},
		},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("edits: %d %s", recorder.Code, recorder.Body.String())
	}
	events := eventsIn(t, server)
	if len(events) != 2 || events[0].Actor != "agent" || events[1].Kind != db.EventSystemRenamed {
		t.Fatalf("events = %+v", events)
	}

	bad := send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": map[string]any{"kind": "human"},
		"edits": []map[string]any{{"op": "nest", "systemId": "nope", "parentId": "orders"}},
	})
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("an impossible edit should be a 400, got %d", bad.Code)
	}
}

func TestOlderRoutesCannotChangeMeaningUnattributed(t *testing.T) {
	server := meaningServer(t)
	for _, attempt := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/systems", map[string]any{"workspaceId": "ws", "name": "Ghost"}},
		{http.MethodPost, "/api/files/billing/assign", map[string]any{"workspaceId": "ws", "systemId": "orders"}},
		{http.MethodDelete, "/api/systems/orders?workspace=ws", nil},
		{http.MethodPut, "/api/systems/orders", map[string]any{"workspaceId": "ws", "name": "Renamed", "source": "user"}},
	} {
		if recorder := send(t, server, attempt.method, attempt.path, attempt.body); recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s %s without an actor: %d %s", attempt.method, attempt.path, recorder.Code, recorder.Body.String())
		}
	}
	if events := eventsIn(t, server); len(events) != 0 {
		t.Fatalf("rejected requests wrote history: %+v", events)
	}

	human := map[string]any{"kind": "human"}
	if r := send(t, server, http.MethodPost, "/api/files/billing/assign", map[string]any{
		"workspaceId": "ws", "systemId": "orders", "actor": human,
	}); r.Code != http.StatusOK {
		t.Fatalf("attributed assign: %d %s", r.Code, r.Body.String())
	}
	if r := send(t, server, http.MethodPost, "/api/files/billing/assign", map[string]any{
		"workspaceId": "ws", "systemId": nil, "actor": human,
	}); r.Code != http.StatusOK {
		t.Fatalf("returning a file to the unsorted bin: %d %s", r.Code, r.Body.String())
	}
	if r := send(t, server, http.MethodDelete, "/api/systems/orders?workspace=ws&actor=human", nil); r.Code != http.StatusOK {
		t.Fatalf("attributed delete: %d %s", r.Code, r.Body.String())
	}
	events := eventsIn(t, server)
	if len(events) != 3 || events[2].Kind != db.EventSystemUngrouped {
		t.Fatalf("want assign, unassign, ungroup: %+v", events)
	}
}

func TestTidyingSavesGeometryWithoutHistory(t *testing.T) {
	server := meaningServer(t)
	recorder := send(t, server, http.MethodPut, "/api/systems/payments", map[string]any{
		"workspaceId": "ws", "name": "Payments", "source": "user",
		"positionX": 640, "positionY": 120, "width": 300, "height": 200,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("tidy save: %d %s", recorder.Code, recorder.Body.String())
	}
	stored, err := db.GetSystem(mustDB(t, server), "payments")
	if err != nil || stored.PositionX != 640 || stored.Width == nil || *stored.Width != 300 {
		t.Fatalf("geometry not saved: %+v %v", stored, err)
	}
	if events := eventsIn(t, server); len(events) != 0 {
		t.Fatalf("presentation wrote history: %+v", events)
	}
}

func TestUndoFromTheReviewAndChangesForAgents(t *testing.T) {
	server := meaningServer(t)
	human := map[string]any{"kind": "human"}
	moved := send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": human,
		"edits": []map[string]any{{"op": "assign", "fileIds": []string{"billing"}, "systemId": "payments"}},
	})
	var result db.MeaningResult
	if err := json.Unmarshal(moved.Body.Bytes(), &result); err != nil || len(result.Changes[0].EventIDs) != 1 {
		t.Fatalf("edit result: %s", moved.Body.String())
	}

	changes := send(t, server, http.MethodGet, "/api/architecture/changes?workspace=ws", nil)
	if changes.Code != http.StatusOK || !bytes.Contains(changes.Body.Bytes(), []byte(`"kind":"moved"`)) {
		t.Fatalf("agents cannot see the move: %d %s", changes.Code, changes.Body.String())
	}

	// Someone moves it again; undoing the first move would overwrite that.
	send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": human,
		"edits": []map[string]any{{"op": "assign", "fileIds": []string{"billing"}, "systemId": "orders"}},
	})
	conflict := send(t, server, http.MethodPost, "/api/architecture/undo", map[string]any{
		"workspaceId": "ws", "actor": human, "eventIds": result.Changes[0].EventIDs,
	})
	if conflict.Code != http.StatusConflict {
		t.Fatalf("want 409 for an undo over later work, got %d %s", conflict.Code, conflict.Body.String())
	}
}

func TestAnEditReportsWhereTheCodeDisagrees(t *testing.T) {
	server := meaningServer(t)
	sqlDB := mustDB(t, server)
	payments := "payments"
	for _, file := range []db.File{
		{ID: "stripe", RelPath: "src/payments/stripe.ts", SystemID: &payments},
		{ID: "invoice", RelPath: "src/payments/invoice.ts", SystemID: &payments},
		{ID: "cart", RelPath: "src/orders/cart.ts"},
	} {
		file.RootID, file.Path, file.Language = "root", "/s/"+file.RelPath, "typescript"
		if err := db.UpsertFile(sqlDB, file); err != nil {
			t.Fatal(err)
		}
	}
	recorder := send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": map[string]any{"kind": "human"},
		"edits": []map[string]any{{"op": "assign", "fileIds": []string{"cart"}, "systemId": "payments"}},
	})
	var result db.MeaningResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.CodeFit) != 1 || result.CodeFit[0].SuggestedPath != "src/payments/cart.ts" {
		t.Fatalf("code fit = %+v", result.CodeFit)
	}
}

func TestTheCodeDisagreementFollowsTheChangeAndItsWorkOrder(t *testing.T) {
	server := meaningServer(t)
	sqlDB := mustDB(t, server)
	payments := "payments"
	for _, file := range []db.File{
		{ID: "stripe", RelPath: "src/payments/stripe.ts", SystemID: &payments},
		{ID: "invoice", RelPath: "src/payments/invoice.ts", SystemID: &payments},
		{ID: "cart", RelPath: "src/orders/cart.ts"},
	} {
		file.RootID, file.Path, file.Language = "root", "/s/"+file.RelPath, "typescript"
		if err := db.UpsertFile(sqlDB, file); err != nil {
			t.Fatal(err)
		}
	}
	send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": map[string]any{"kind": "human"},
		"edits": []map[string]any{{"op": "assign", "fileIds": []string{"cart"}, "systemId": "payments"}},
	})

	// An agent starting work hears about it.
	changes := send(t, server, http.MethodGet, "/api/architecture/changes?workspace=ws", nil)
	if !bytes.Contains(changes.Body.Bytes(), []byte(`"toFix":"Move src/orders/cart.ts to src/payments/cart.ts`)) {
		t.Fatalf("changes do not say where the code disagrees: %s", changes.Body.String())
	}

	// The review keeps the offer.
	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	summary := delta.Aggregate(events, 0, 1<<62)
	claims := attachCodeFit(sqlDB, "ws", delta.BuildClaims(summary, nil))
	found := false
	for _, claim := range claims {
		if claim.Kind == delta.ClaimMoved && len(claim.CodeFit) == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("the move claim does not carry the disagreement: %+v", claims)
	}

	// A work order sent to fix it is checked by Axiom.
	sent := send(t, server, http.MethodPost, "/api/canvas/send", map[string]any{
		"workspaceId": "ws", "note": "make the code match", "selection": "[]",
		"codeFitFileIds": []string{"cart"},
	})
	if sent.Code != http.StatusOK {
		t.Fatalf("send: %d %s", sent.Code, sent.Body.String())
	}
	history := send(t, server, http.MethodGet, "/api/canvas/history?workspace=ws", nil)
	if !bytes.Contains(history.Body.Bytes(), []byte(`"state":"disagrees"`)) {
		t.Fatalf("history has no code check: %s", history.Body.String())
	}
	if _, err := sqlDB.Exec(`UPDATE files SET rel_path = 'src/payments/cart.ts' WHERE id = 'cart'`); err != nil {
		t.Fatal(err)
	}
	history = send(t, server, http.MethodGet, "/api/canvas/history?workspace=ws", nil)
	if !bytes.Contains(history.Body.Bytes(), []byte(`"state":"agrees"`)) {
		t.Fatalf("the check did not follow the code: %s", history.Body.String())
	}
}

func TestAWorkOrderToRemoveCodeIsCheckedForTheRemoval(t *testing.T) {
	server := meaningServer(t)
	sqlDB := mustDB(t, server)
	created := send(t, server, http.MethodPost, "/api/sheets", map[string]any{"workspaceId": "ws", "name": "Retire billing"})
	var sheet db.Sheet
	if err := json.Unmarshal(created.Body.Bytes(), &sheet); err != nil || sheet.ID == "" {
		t.Fatalf("create sheet: %s", created.Body.String())
	}
	if r := send(t, server, http.MethodPost, "/api/sheets/"+sheet.ID+"/removals", map[string]any{"workspaceId": "ws", "nodeId": "billing"}); r.Code != http.StatusOK {
		t.Fatalf("propose removal: %d %s", r.Code, r.Body.String())
	}
	loaded := send(t, server, http.MethodGet, "/api/sheets/"+sheet.ID+"?workspace=ws", nil)
	if !bytes.Contains(loaded.Body.Bytes(), []byte(`"removals":[{"sheetId"`)) {
		t.Fatalf("the sheet does not list its removal: %s", loaded.Body.String())
	}
	sent := send(t, server, http.MethodPost, "/api/canvas/send", map[string]any{
		"id": "remove-billing", "workspaceId": "ws", "note": "Delete billing.ts", "selection": "[]",
		"sheetId": sheet.ID, "deliveryMode": "addressed",
	})
	if sent.Code != http.StatusOK {
		t.Fatalf("send: %d %s", sent.Code, sent.Body.String())
	}
	spec := send(t, server, http.MethodGet, "/api/sheets/"+sheet.ID+"/buildspec?workspace=ws", nil)
	if !bytes.Contains(spec.Body.Bytes(), []byte("remove file://billing.ts [OPEN]")) {
		t.Fatalf("the build spec does not ask for the removal: %s", spec.Body.String())
	}
	check := func() string {
		return send(t, server, http.MethodGet, "/api/canvas/snapshot-comparison?workspace=ws&messageId=remove-billing", nil).Body.String()
	}
	if !strings.Contains(check(), `"kind":"removal"`) {
		t.Fatalf("the sent removal is not checked: %s", check())
	}
	if err := db.DeleteFileByID(sqlDB, "billing"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(check(), `"kind":"removal"`) {
		t.Fatalf("the removal is still open after the file is gone: %s", check())
	}
	if r := send(t, server, http.MethodDelete, "/api/sheets/"+sheet.ID+"/removals/billing?workspace=ws", nil); r.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", r.Code, r.Body.String())
	}
}

func TestAnAgentStartingWorkHearsWhatThePersonChanged(t *testing.T) {
	server := meaningServer(t)
	start := func(agent string) map[string]any {
		t.Helper()
		r := send(t, server, http.MethodPost, "/api/work/start", map[string]any{"workspaceId": "ws", "agent": agent, "goal": "add refunds"})
		if r.Code != http.StatusOK {
			t.Fatalf("start: %d %s", r.Code, r.Body.String())
		}
		var body map[string]any
		_ = json.Unmarshal(r.Body.Bytes(), &body)
		return body
	}
	// An agent's own edits are not news to it.
	send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": map[string]any{"kind": "agent", "agent": "codex"},
		"edits": []map[string]any{{"op": "rename", "systemId": "orders", "name": "Checkout"}},
	})
	if body := start("codex"); body["mapChanges"] != nil {
		t.Fatalf("an agent was briefed on agent edits: %v", body["mapChanges"])
	}
	time.Sleep(5 * time.Millisecond)
	send(t, server, http.MethodPost, "/api/architecture/edits", map[string]any{
		"workspaceId": "ws", "actor": map[string]any{"kind": "human"},
		"edits": []map[string]any{{"op": "assign", "fileIds": []string{"billing"}, "systemId": "payments"}},
	})
	briefing, _ := start("codex")["mapChanges"].(map[string]any)
	changes, _ := briefing["changes"].([]any)
	if len(changes) != 1 || !strings.Contains(changes[0].(map[string]any)["what"].(string), "billing.ts moved") {
		t.Fatalf("briefing = %v", briefing)
	}
	// Told once: the next session starts after it.
	time.Sleep(5 * time.Millisecond)
	if body := start("codex"); body["mapChanges"] != nil {
		t.Fatalf("the same change was told twice: %v", body["mapChanges"])
	}
	// Another agent, never seen here, hears it too.
	if body := start("claude-code"); body["mapChanges"] == nil {
		t.Fatal("a new agent was not briefed")
	}
}

func TestARejectionAndItsReasonReachTheNextAgent(t *testing.T) {
	server := meaningServer(t)
	sqlDB := mustDB(t, server)
	if err := db.CreateSheet(sqlDB, &db.Sheet{ID: "plan", WorkspaceID: "ws", Name: "Agent Plan"}); err != nil {
		t.Fatal(err)
	}
	proposal := &db.PlannedNode{SheetID: "plan", WorkspaceID: "ws", Kind: "system", Name: "Job Queue", CreatedBy: "agent"}
	if err := db.UpsertPlannedNode(sqlDB, proposal); err != nil {
		t.Fatal(err)
	}
	r := send(t, server, http.MethodPost, "/api/planned/"+proposal.ID+"/approval", map[string]any{
		"workspaceId": "ws", "decision": "rejected", "reason": "we already queue through SQS",
	})
	if r.Code != http.StatusOK {
		t.Fatalf("reject: %d %s", r.Code, r.Body.String())
	}
	started := send(t, server, http.MethodPost, "/api/work/start", map[string]any{"workspaceId": "ws", "agent": "codex", "goal": "add retries"})
	want := "The user rejected the proposed system Job Queue on Agent Plan: we already queue through SQS"
	if !strings.Contains(started.Body.String(), want) {
		t.Fatalf("the next session was not told: %s", started.Body.String())
	}
	// The rejection is not a change to the map, so Review Changes stays quiet about it.
	events, _ := db.GetStructuralEvents(sqlDB, "ws", 0)
	claims := delta.BuildClaims(delta.Aggregate(events, 0, 1<<62), nil)
	for _, claim := range claims {
		if strings.Contains(claim.Title, "Job Queue") {
			t.Fatalf("a decision became a claim: %+v", claim)
		}
	}
}
