package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
)

func sheetComparison(t *testing.T, mux http.Handler, id string) db.SheetComparison {
	t.Helper()
	r := inboxHTTP(t, mux, "GET", "/api/sheets/"+id+"/compare?workspace=ws", nil)
	var c db.SheetComparison
	if err := json.Unmarshal(r.Body.Bytes(), &c); err != nil || r.Code != 200 {
		t.Fatal(r.Code, r.Body.String(), err)
	}
	return c
}

func TestWorkOrderSnapshotComparisonRechecksFrozenFileContract(t *testing.T) {
	s, mux, root := inboxServer(t)
	d, _ := s.dbFor("ws")
	path := filepath.Join(root, "rate.ts")
	matching := "interface RateLimiter {\n allow(key: string): boolean\n}\n"
	if err := os.WriteFile(path, []byte(matching), 0600); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertFile(d, db.File{ID: "rate-file", RootID: "root", Path: path, RelPath: "rate.ts", Language: "typescript"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertSymbols(d, "rate-file", []db.Symbol{{Name: "RateLimiter", Kind: "interface", LineStart: 1, LineEnd: 3}, {Name: "allow", Kind: "method", LineStart: 2, LineEnd: 2}}); err != nil {
		t.Fatal(err)
	}
	sheet := db.Sheet{ID: "contract-sheet", WorkspaceID: "ws", Name: "Rate limit contract"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	plan := db.PlannedNode{ID: "rate-plan", SheetID: sheet.ID, WorkspaceID: "ws", Name: "RateLimiter", DeclaredPath: "rate.ts", Kind: "class", Metadata: json.RawMessage(`{"version":1,"methods":[{"name":"allow","parameters":[{"name":"key","dataType":"string"}],"returnType":"boolean"}]}`)}
	if err := db.UpsertPlannedNode(d, &plan); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ReconcilePlanned(d, "ws"); err != nil {
		t.Fatal(err)
	}
	if sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"workspaceId": "ws", "id": "contract-order", "sheetId": sheet.ID, "note": "Keep this contract"}); sent.Code != http.StatusOK {
		t.Fatal(sent.Code, sent.Body.String())
	}
	if original := sentComparison(t, mux, "contract-order"); !original.Equivalent {
		t.Fatalf("matching sent contract was rejected: %+v", original)
	}
	if err := os.WriteFile(path, []byte("interface RateLimiter {\n allow(key: number): string\n}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if drifted := sentComparison(t, mux, "contract-order"); drifted.Equivalent || len(drifted.Differences) == 0 {
		t.Fatalf("source drift did not invalidate sent contract: %+v", drifted)
	}
	if err := os.WriteFile(path, []byte(matching), 0600); err != nil {
		t.Fatal(err)
	}
	if restored := sentComparison(t, mux, "contract-order"); !restored.Equivalent {
		t.Fatalf("restored source did not match sent contract: %+v", restored)
	}
}

func sentComparison(t *testing.T, mux http.Handler, id string) db.WorkOrderSnapshotComparison {
	t.Helper()
	r := inboxHTTP(t, mux, "GET", "/api/canvas/snapshot-comparison?workspace=ws&messageId="+id, nil)
	var c db.WorkOrderSnapshotComparison
	if err := json.Unmarshal(r.Body.Bytes(), &c); err != nil || r.Code != http.StatusOK {
		t.Fatal(r.Code, r.Body.String(), err)
	}
	return c
}

func TestWorkOrderSnapshotComparisonDoesNotCertifyLegacySnapshots(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	sheet := db.Sheet{ID: "legacy-design", WorkspaceID: "ws", Name: "Older plan"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ id, context string }{
		{"broken", "not json"},
		{"empty", `{}`},
		{"old-edge", `{"sheet":{"id":"legacy-design","revision":1},"edges":[{"kind":"CALLS","planned":true}]}`},
	} {
		t.Run(test.id, func(t *testing.T) {
			message := db.CanvasMessage{ID: test.id, WorkspaceID: "ws", SheetID: &sheet.ID, SheetContext: test.context}
			if err := db.EnqueueCanvasMessage(d, &message); err != nil {
				t.Fatal(err)
			}
			comparison := sentComparison(t, mux, message.ID)
			if comparison.Equivalent || len(comparison.Differences) == 0 {
				t.Fatalf("unverifiable legacy plan passed: %+v", comparison)
			}
			for _, difference := range comparison.Differences {
				if difference.Kind != "unverifiable" {
					t.Fatalf("legacy evidence should be explicitly unverified: %+v", difference)
				}
			}
		})
	}
}

func TestWorkOrderSnapshotComparisonKeepsSentNestingAfterSheetEdits(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	for _, id := range []string{"old", "new", "child"} {
		if err := db.UpsertSystem(d, db.System{ID: id, Name: id, WorkspaceID: "ws", Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	sheet := db.Sheet{ID: "frozen-design", WorkspaceID: "ws", Name: "Original architecture"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	old, newParent, parentType := "old", "new", "system"
	if _, err := db.ApplySheetLayoutBatch(d, sheet.ID, "ws", []db.SheetLayout{{NodeID: "child", NodeType: "system", ParentNodeID: &old, ParentNodeType: &parentType, Width: 300, Height: 200, Scale: 1}}); err != nil {
		t.Fatal(err)
	}
	if sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"workspaceId": "ws", "id": "frozen-order", "sheetId": sheet.ID, "note": "Build original nesting"}); sent.Code != http.StatusOK {
		t.Fatal(sent.Code, sent.Body.String())
	}
	if initial := sentComparison(t, mux, "frozen-order"); initial.Equivalent || len(initial.Differences) == 0 {
		t.Fatalf("unimplemented nesting matched: %+v", initial)
	}
	if _, err := db.ApplyFloorLayoutBatch(d, "ws", []db.FloorLayout{{NodeID: "child", NodeType: "system", ParentNodeID: &old, ParentNodeType: &parentType, Width: 300, Height: 200, Scale: 1}}); err != nil {
		t.Fatal(err)
	}
	if matched := sentComparison(t, mux, "frozen-order"); !matched.Equivalent || matched.Checked != 1 {
		t.Fatalf("implemented sent nesting did not match: %+v", matched)
	}
	if _, err := db.ApplySheetLayoutBatch(d, sheet.ID, "ws", []db.SheetLayout{{NodeID: "child", NodeType: "system", ParentNodeID: &newParent, ParentNodeType: &parentType, Width: 300, Height: 200, Scale: 1}}); err != nil {
		t.Fatal(err)
	}
	if current := sheetComparison(t, mux, sheet.ID); current.Equivalent {
		t.Fatal("current sheet should ask for the new parent")
	}
	if frozen := sentComparison(t, mux, "frozen-order"); !frozen.Equivalent || frozen.CurrentSheetRevision <= frozen.Revision {
		t.Fatalf("later edit changed the sent target: %+v", frozen)
	}
	if _, err := d.Exec(`DELETE FROM sheets WHERE id=?`, sheet.ID); err != nil {
		t.Fatal(err)
	}
	if frozen := sentComparison(t, mux, "frozen-order"); !frozen.Equivalent || frozen.CurrentSheetRevision != 0 {
		t.Fatalf("deleting the sheet changed the sent target: %+v", frozen)
	}
	if other := inboxHTTP(t, mux, "GET", "/api/canvas/snapshot-comparison?workspace=other&messageId=frozen-order", nil); other.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace comparison status %d", other.Code)
	}
}

func TestWorkOrderSnapshotComparisonChecksSentRelationship(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	for _, id := range []string{"host", "child"} {
		if err := db.UpsertSystem(d, db.System{ID: id, Name: id, WorkspaceID: "ws", Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	sheet := db.Sheet{ID: "edge-design", WorkspaceID: "ws", Name: "Containment"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	host, child := "host", "child"
	if err := db.UpsertPlannedEdge(d, &db.PlannedEdge{ID: "contains", SheetID: sheet.ID, WorkspaceID: "ws", SrcLive: &host, DstLive: &child, Kind: "CONTAINS"}); err != nil {
		t.Fatal(err)
	}
	if sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"workspaceId": "ws", "id": "edge-order", "sheetId": sheet.ID, "note": "Contain child"}); sent.Code != http.StatusOK {
		t.Fatal(sent.Code, sent.Body.String())
	}
	if missing := sentComparison(t, mux, "edge-order"); missing.Equivalent || missing.Checked != 1 {
		t.Fatalf("absent sent relationship passed: %+v", missing)
	}
	parentType := "system"
	if _, err := db.ApplyFloorLayoutBatch(d, "ws", []db.FloorLayout{{NodeID: child, NodeType: "system", ParentNodeID: &host, ParentNodeType: &parentType, Width: 300, Height: 200, Scale: 1}}); err != nil {
		t.Fatal(err)
	}
	if matched := sentComparison(t, mux, "edge-order"); !matched.Equivalent || matched.Checked != 1 {
		t.Fatalf("sent relationship did not match: %+v", matched)
	}
	if _, err := d.Exec(`DELETE FROM planned_edges WHERE id='contains'`); err != nil {
		t.Fatal(err)
	}
	if frozen := sentComparison(t, mux, "edge-order"); !frozen.Equivalent {
		t.Fatalf("deleting current relationship edited the sent target: %+v", frozen)
	}
}

func TestWorkOrderSnapshotComparisonAcceptsAnUnchangedProposalBinding(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	sheet := db.Sheet{ID: "proposed-design", WorkspaceID: "ws", Name: "New service"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	plan := db.PlannedNode{ID: "new-service-plan", SheetID: sheet.ID, WorkspaceID: "ws", Name: "New service", Kind: "system", Metadata: json.RawMessage(`{"purpose":"Own checkout"}`)}
	if err := db.UpsertPlannedNode(d, &plan); err != nil {
		t.Fatal(err)
	}
	if sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"workspaceId": "ws", "id": "proposal-order", "sheetId": sheet.ID, "note": "Build new service"}); sent.Code != http.StatusOK {
		t.Fatal(sent.Code, sent.Body.String())
	}
	if missing := sentComparison(t, mux, "proposal-order"); missing.Equivalent {
		t.Fatalf("unbound proposal passed: %+v", missing)
	}
	if err := db.UpsertSystem(d, db.System{ID: "new-service", Name: "New service", WorkspaceID: "ws", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	current, err := db.GetSheet(d, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.BindSheetNode(d, "ws", sheet.ID, plan.ID, "new-service", current.Revision); err != nil {
		t.Fatal(err)
	}
	if matched := sentComparison(t, mux, "proposal-order"); !matched.Equivalent || matched.Mappings["planned:"+plan.ID] != "new-service" {
		t.Fatalf("matching proposal binding did not satisfy sent plan: %+v", matched)
	}
	plan.Name = "Different service"
	if err := db.UpsertPlannedNode(d, &plan); err != nil {
		t.Fatal(err)
	}
	if changed := sentComparison(t, mux, "proposal-order"); changed.Equivalent {
		t.Fatalf("changed current proposal reused its binding for the sent plan: %+v", changed)
	}
}

func TestSheetStructuralLifecycleIgnoresPixelsButChecksCanonicalNesting(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	for _, id := range []string{"old", "new", "child"} {
		if err := db.UpsertSystem(d, db.System{ID: id, Name: id, WorkspaceID: "ws", Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	sheet := db.Sheet{ID: "design", WorkspaceID: "ws", Name: "Checkout redesign"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	child, old, parentType := "child", "old", "system"
	if err := db.AddSheetElement(d, &db.SheetElement{ID: "element", SheetID: sheet.ID, SystemID: &child, ParentSystemID: &old, Label: "child"}); err != nil {
		t.Fatal(err)
	}
	newParent := "new"
	if _, err := db.ApplySheetLayoutBatch(d, sheet.ID, "ws", []db.SheetLayout{{NodeID: child, NodeType: "system", ParentNodeID: &newParent, ParentNodeType: &parentType, PositionX: 900, PositionY: 800, Width: 600, Height: 400, Scale: 2}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ApplyFloorLayoutBatch(d, "ws", []db.FloorLayout{{NodeID: child, NodeType: "system", ParentNodeID: &old, ParentNodeType: &parentType, PositionX: 12, PositionY: 13, Width: 220, Height: 110, Scale: 1}}); err != nil {
		t.Fatal(err)
	}
	c := sheetComparison(t, mux, sheet.ID)
	if c.Equivalent || len(c.Differences) != 1 || c.Differences[0].Expected != "new" {
		t.Fatalf("%+v", c)
	}
	// Export must use canonical nesting, not deprecated element columns.
	r := inboxHTTP(t, mux, "GET", "/api/sheets/design/context?workspace=ws", nil)
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"parentRef":"sys://new"`) {
		t.Fatal(r.Body.String())
	}
	sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{"workspaceId": "ws", "id": "sheet-message", "sheetId": sheet.ID, "note": "Implement this sheet"})
	if sent.Code != 200 {
		t.Fatal(sent.Code, sent.Body.String())
	}
	message, err := db.GetCanvasMessage(d, "sheet-message")
	if err != nil {
		t.Fatal(err)
	}
	var frozen struct {
		Comparison db.SheetComparison `json:"comparisonAtSend"`
	}
	if err = json.Unmarshal([]byte(message.SheetContext), &frozen); err != nil || frozen.Comparison.Token != c.Token {
		t.Fatal("invalid or inconsistent comparison snapshot", err)
	}
	payload := map[string]any{"workspaceId": "ws", "revision": c.Revision, "token": c.Token}
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/resolve", payload); r.Code != 409 {
		t.Fatal(r.Code, r.Body.String())
	}
	payload["nodeId"] = child
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/apply_nesting", payload); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	layouts, _ := db.GetFloorLayouts(d, "ws")
	if layouts[0].PositionX != 12 || layouts[0].Scale != 1 || *layouts[0].ParentNodeID != "new" {
		t.Fatal(layouts)
	}
	delete(payload, "nodeId")
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/resolve", payload); r.Code != 409 {
		t.Fatal("stale comparison accepted", r.Code)
	}
	c = sheetComparison(t, mux, sheet.ID)
	if !c.Equivalent {
		t.Fatalf("%+v", c)
	}
	// Coordinates are intentionally excluded from the equivalence token.
	layouts[0].PositionX = 7000
	if _, err := db.ApplyFloorLayoutBatch(d, "ws", layouts); err != nil {
		t.Fatal(err)
	}
	if next := sheetComparison(t, mux, sheet.ID); next.Token != c.Token {
		t.Fatal("pixels changed structural token")
	}
	payload["token"] = c.Token
	for i := 0; i < 2; i++ {
		if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/resolve", payload); r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	saved, _ := db.GetSheet(d, sheet.ID)
	if saved.ResolvedAt == nil {
		t.Fatal("not archived")
	}
	var context string
	if err := d.QueryRow(`SELECT context FROM sheet_resolutions WHERE sheet_id='design'`).Scan(&context); err != nil || !strings.Contains(context, "sys://new") {
		t.Fatal(context, err)
	}
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/reopen", map[string]any{"workspaceId": "ws", "revision": saved.Revision}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	reopened, _ := db.GetSheet(d, sheet.ID)
	if reopened.ResolvedAt != nil || reopened.Revision <= saved.Revision {
		t.Fatal(reopened)
	}
}

func TestSheetComparisonPlannedBindingsApprovalRelationshipsAndScope(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	sheet := db.Sheet{ID: "design", WorkspaceID: "ws", Name: "Design"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	p := db.PlannedNode{ID: "new", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "system", Name: "New system", CreatedBy: "agent"}
	if err := db.UpsertPlannedNode(d, &p); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertSystem(d, db.System{ID: "real", Name: p.Name, WorkspaceID: "ws", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	c := sheetComparison(t, mux, sheet.ID)
	bind := map[string]any{"workspaceId": "ws", "revision": c.Revision, "plannedId": p.ID, "liveId": "real"}
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/bind", bind); r.Code == 200 {
		t.Fatal("pending proposal bound")
	}
	p.ApprovalStatus = "approved"
	if err := db.UpsertPlannedNode(d, &p); err != nil {
		t.Fatal(err)
	}
	c = sheetComparison(t, mux, sheet.ID)
	bind["revision"] = c.Revision
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/bind", bind); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	c = sheetComparison(t, mux, sheet.ID)
	if !c.Equivalent || c.Mappings["planned:new"] != "real" {
		t.Fatalf("%+v", c)
	}
	// A sheet is scoped: unrelated live files are not deletions.
	if len(c.Differences) != 0 {
		t.Fatal(c.Differences)
	}
	source, dest := "new", "file"
	if err := db.UpsertPlannedEdge(d, &db.PlannedEdge{ID: "edge", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "DEPENDS_ON", SrcPlanned: &source, DstLive: &dest}); err != nil {
		t.Fatal(err)
	}
	c = sheetComparison(t, mux, sheet.ID)
	if c.Equivalent || c.Differences[0].Kind != "relationship" {
		t.Fatal(c.Differences)
	}
	if r := inboxHTTP(t, mux, "GET", "/api/sheets/design/compare?workspace=other", nil); r.Code != 404 {
		t.Fatal("foreign workspace read", r.Code)
	}
}

func TestEmptySheetCannotResolveAndBindingCannotForgeFileImplementation(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	sheet := db.Sheet{ID: "design", WorkspaceID: "ws", Name: "Design"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	if c := sheetComparison(t, mux, sheet.ID); c.Equivalent {
		t.Fatal("empty sheet equivalent")
	}
	p := db.PlannedNode{ID: "planned-file", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "class", Name: "Unimplemented"}
	if err := db.UpsertPlannedNode(d, &p); err != nil {
		t.Fatal(err)
	}
	c := sheetComparison(t, mux, sheet.ID)
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/bind", map[string]any{"workspaceId": "ws", "revision": c.Revision, "plannedId": p.ID, "liveId": "file"}); r.Code == 200 {
		t.Fatal("forged file realization")
	}
	// Even a legacy/raw status mutation cannot make checked resolution accept
	// unimplemented source. Resolution independently refreshes contract evidence.
	fileID := "file"
	p.Status = "realized"
	p.RealizedFileID = &fileID
	p.DeclaredPath = "hello.go"
	if err := db.UpsertPlannedNode(d, &p); err != nil {
		t.Fatal(err)
	}
	c = sheetComparison(t, mux, sheet.ID)
	if r := inboxHTTP(t, mux, "POST", "/api/sheets/design/resolve", map[string]any{"workspaceId": "ws", "revision": c.Revision, "token": c.Token}); r.Code != 409 {
		t.Fatal("claimed status bypassed verification", r.Code, r.Body.String())
	}
}
