package db

import "testing"

func TestNotesUseScopedNativeLayoutTransactions(t *testing.T) {
	directory := t.TempDir()
	database, err := Open(directory)
	must(t, err)
	t.Cleanup(func() { database.Close() })
	must(t, UpsertWorkspace(database, Workspace{ID: "ws", Name: "Notes"}))
	must(t, UpsertSystem(database, System{ID: "owner", WorkspaceID: "ws", Name: "Owner", Source: "user"}))
	first, second := Sheet{ID: "first", WorkspaceID: "ws", Name: "First"}, Sheet{ID: "second", WorkspaceID: "ws", Name: "Second"}
	must(t, CreateSheet(database, &first))
	must(t, CreateSheet(database, &second))
	floor := Annotation{ID: "floor-note", WorkspaceID: "ws", Body: "Floor comment"}
	sheet := Annotation{ID: "sheet-note", WorkspaceID: "ws", SheetID: &first.ID, Body: "Sheet comment"}
	must(t, CreateAnnotation(database, &floor))
	must(t, CreateAnnotation(database, &sheet))
	owner, kind := "owner", "system"
	layout := FloorLayout{NodeID: "note:" + floor.ID, NodeType: "note", ParentNodeID: &owner, ParentNodeType: &kind, ContainmentKind: "part_of", PositionX: 30, PositionY: 100, Width: 260, Height: 180, Scale: 1, InteriorScale: 1}
	_, err = ApplyFloorLayoutBatch(database, "ws", []FloorLayout{layout})
	must(t, err)
	current, err := GetAnnotation(database, "ws", floor.ID)
	must(t, err)
	if current.Layout == nil || *current.Layout.ParentNodeID != owner || current.Revision != 1 {
		t.Fatalf("native geometry must preserve the text revision: %#v", current)
	}
	// The same sheet transaction handles its own note and Floor context geometry.
	_, err = ApplySheetLayoutBatch(database, first.ID, "ws", []SheetLayout{{NodeID: "note:" + sheet.ID, NodeType: "note", ParentNodeID: &owner, ParentNodeType: &kind, PositionX: 40, PositionY: 110, Width: 260, Height: 180, Scale: 1, InteriorScale: 1}, {NodeID: layout.NodeID, NodeType: "note", ParentNodeID: &owner, ParentNodeType: &kind, PositionX: 60, PositionY: 120, Width: 260, Height: 180, Scale: 1, InteriorScale: 1}})
	must(t, err)
	if _, err = ApplyFloorLayoutBatch(database, "ws", []FloorLayout{{NodeID: "note:" + sheet.ID, NodeType: "note", Width: 260, Height: 180, Scale: 1}}); err == nil {
		t.Fatal("sheet note leaked into Floor layout")
	}
	if _, err = ApplySheetLayoutBatch(database, second.ID, "ws", []SheetLayout{{NodeID: "note:" + sheet.ID, NodeType: "note", Width: 260, Height: 180, Scale: 1}}); err == nil {
		t.Fatal("note leaked into a different sheet")
	}
	must(t, database.Close())
	database, err = Open(directory)
	must(t, err)
	reopened, err := GetAnnotation(database, "ws", sheet.ID)
	must(t, err)
	if reopened.Layout == nil || reopened.Layout.ParentNodeID == nil || *reopened.Layout.ParentNodeID != owner {
		t.Fatalf("note lost its parent after reopening: %#v", reopened)
	}
	// Invalid native placement and text changes roll back together.
	bad := "missing"
	invalid := layout
	invalid.ParentNodeID = &bad
	current.Body = "Must roll back"
	if err = UpdateAnnotationAndLayout(database, current, 1, &invalid); err == nil {
		t.Fatal("invalid owner accepted")
	}
	current, err = GetAnnotation(database, "ws", floor.ID)
	must(t, err)
	if current.Body != "Floor comment" || current.Revision != 1 || *current.Layout.ParentNodeID != owner {
		t.Fatalf("partial note transaction: %#v", current)
	}
	must(t, DeleteAnnotationRevision(database, "ws", floor.ID, 1))
	rows, err := GetFloorLayouts(database, "ws")
	must(t, err)
	for _, row := range rows {
		if row.NodeID == layout.NodeID {
			t.Fatal("deleted note left a Floor layout")
		}
	}
	sheetRows, err := GetSheetLayouts(database, first.ID)
	must(t, err)
	for _, row := range sheetRows {
		if row.NodeID == layout.NodeID {
			t.Fatal("deleted note left a sheet context override")
		}
	}
}
