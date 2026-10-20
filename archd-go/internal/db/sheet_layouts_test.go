package db

import "testing"

func TestCanonicalSheetLayoutMatchesFloorAlgebraWithoutChangingOwnership(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, system := range []System{
		{ID: "parent", WorkspaceID: "ws", Name: "parent", Source: "user"},
		{ID: "child", WorkspaceID: "ws", Name: "child", Source: "user"},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "proposal"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}

	parentID, parentType := "parent", "system"
	result, err := ApplySheetLayoutBatch(sqlDB, sheet.ID, "ws", []SheetLayout{{
		NodeID:          "child",
		NodeType:        "system",
		ParentNodeID:    &parentID,
		ParentNodeType:  &parentType,
		ContainmentKind: "part_of",
		PositionX:       12.5,
		PositionY:       33.25,
		Width:           640,
		Height:          480,
		Scale:           0.75,
		InteriorScale:   0.625,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != int64(sheet.Revision+1) {
		t.Fatalf("revision = %d, want %d", result.Revision, sheet.Revision+1)
	}
	layouts, err := GetSheetLayouts(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 1 {
		t.Fatalf("layouts = %#v", layouts)
	}
	got := layouts[0]
	if got.PositionX != 12.5 || got.PositionY != 33.25 ||
		got.Width != 640 || got.Height != 480 ||
		got.Scale != 0.75 || got.InteriorScale != 0.625 {
		t.Fatalf("canonical geometry was not preserved: %#v", got)
	}
	child, err := GetSystem(sqlDB, "child")
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentID != nil {
		t.Fatalf("sheet layout changed semantic ownership: %#v", child.ParentID)
	}
}

func TestCanonicalSheetLayoutRejectsCyclesAcrossFloorAndSheetOverrides(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, system := range []System{
		{ID: "a", WorkspaceID: "ws", Name: "a", Source: "user"},
		{ID: "b", WorkspaceID: "ws", Name: "b", Source: "user"},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "proposal"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	a, b, systemType := "a", "b", "system"
	_, err = ApplySheetLayoutBatch(sqlDB, sheet.ID, "ws", []SheetLayout{
		{
			NodeID: "a", NodeType: "system", ParentNodeID: &b, ParentNodeType: &systemType,
			Width: 620, Height: 420, Scale: 1, InteriorScale: 1,
		},
		{
			NodeID: "b", NodeType: "system", ParentNodeID: &a, ParentNodeType: &systemType,
			Width: 620, Height: 420, Scale: 1, InteriorScale: 1,
		},
	})
	if err == nil {
		t.Fatal("expected canonical sheet layout cycle to be rejected")
	}
}

// An agent that names a system for a sheet, or draws a planned node, without
// saying where, gives no layout opinion: the system stays where the Floor has
// it and the planned node is placed by the canvas, not pinned to (0, 0).
func TestUnplacedSheetMembersGetNoLayoutAndOldOriginPinsAreRepaired(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"named", "placed"} {
		if err := UpsertSystem(sqlDB, System{ID: id, WorkspaceID: "ws", Name: id, Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "proposal"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	named, placed := "named", "placed"
	width := 300.0
	for _, element := range []SheetElement{
		{SheetID: sheet.ID, SystemID: &named, Label: "named", Scale: 1},
		{SheetID: sheet.ID, SystemID: &placed, Label: "placed", PositionX: 40, PositionY: 60, Width: &width, Height: &width, Scale: 1},
	} {
		element := element
		if err := AddSheetElement(sqlDB, &element); err != nil {
			t.Fatal(err)
		}
	}
	drawn := PlannedNode{ID: "drawn", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "system", Name: "Drawn"}
	if err := UpsertPlannedNode(sqlDB, &drawn); err != nil {
		t.Fatal(err)
	}
	nodes := func() map[string]SheetLayout {
		layouts, err := GetSheetLayouts(sqlDB, sheet.ID)
		if err != nil {
			t.Fatal(err)
		}
		byID := map[string]SheetLayout{}
		for _, layout := range layouts {
			byID[layout.NodeID] = layout
		}
		return byID
	}

	if err := BackfillSheetLayouts(sqlDB); err != nil {
		t.Fatal(err)
	}
	got := nodes()
	if _, ok := got["named"]; ok {
		t.Fatalf("a system named without geometry got a layout: %#v", got["named"])
	}
	if _, ok := got["planned:drawn"]; ok {
		t.Fatalf("a planned node drawn without a position got a layout: %#v", got["planned:drawn"])
	}
	if layout, ok := got["placed"]; !ok || layout.PositionX != 40 || layout.Width != 300 {
		t.Fatalf("a placed member lost its geometry: %#v", got["placed"])
	}

	// What earlier backfills wrote: the unplaced members pinned to the origin.
	for _, id := range []string{"named", "planned:drawn"} {
		if _, err := sqlDB.Exec(`INSERT INTO sheet_layouts
			(sheet_id,workspace_id,node_id,node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
			VALUES(?,?,?,'system','root',0,0,620,420,1,1,1)`, sheet.ID, "ws", id); err != nil {
			t.Fatal(err)
		}
	}
	if err := RepairUnplacedSheetLayouts(sqlDB); err != nil {
		t.Fatal(err)
	}
	got = nodes()
	if len(got) != 1 || got["placed"].PositionX != 40 {
		t.Fatalf("repair should keep only the placed member: %#v", got)
	}
}
