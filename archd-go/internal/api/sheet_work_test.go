package api

import (
	"encoding/json"
	"net/http"
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
