package db

import (
	"errors"
	"testing"
)

// Undo puts the map back the way it was, records that it did, and refuses to
// overwrite anything that changed afterwards.

func lastEventIDs(t *testing.T, result MeaningResult) []int64 {
	t.Helper()
	ids := []int64{}
	for _, change := range result.Changes {
		ids = append(ids, change.EventIDs...)
	}
	return ids
}

func TestUndoingAMovePutsTheFileBackAndSaysSo(t *testing.T) {
	sqlDB := meaningFixture(t)
	moved, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"},
	})
	must(t, err)
	_, err = UndoMeaningEvents(sqlDB, "ws", MeaningActor{Kind: "agent", Agent: "codex"}, lastEventIDs(t, moved))
	must(t, err)
	if systemOf(t, sqlDB, "billing") != "orders" {
		t.Fatal("undo did not put billing.ts back in Orders")
	}
	events := journal(t, sqlDB)
	if len(events) != 2 || events[1].Actor != "agent" {
		t.Fatalf("want the move and an agent's undo, got %+v", events)
	}
	undoes := detailOf(t, events[1])["undoes"].([]any)
	if int64(undoes[0].(float64)) != events[0].ID {
		t.Fatalf("undo does not name the row it reverses: %v", undoes)
	}
}

func TestUndoRefusesToOverwriteLaterWork(t *testing.T) {
	sqlDB := meaningFixture(t)
	first, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"},
	})
	must(t, err)
	_, err = ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "refunds"},
	})
	must(t, err)
	_, err = UndoMeaningEvents(sqlDB, "ws", human, lastEventIDs(t, first))
	if !errors.Is(err, ErrMeaningConflict) {
		t.Fatalf("want a conflict, got %v", err)
	}
	if systemOf(t, sqlDB, "billing") != "refunds" || len(journal(t, sqlDB)) != 2 {
		t.Fatal("a refused undo changed something")
	}
}

func TestUndoingAGroupingReturnsItsFiles(t *testing.T) {
	sqlDB := meaningFixture(t)
	grouped, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningCreate, Name: "Checkout", FileIDs: []string{"cart", "loose"}},
	})
	must(t, err)
	_, err = UndoMeaningEvents(sqlDB, "ws", human, lastEventIDs(t, grouped))
	must(t, err)
	if systemOf(t, sqlDB, "cart") != "orders" || systemOf(t, sqlDB, "loose") != "" {
		t.Fatal("files did not return to where they came from")
	}
	if gone, _ := GetSystem(sqlDB, grouped.Changes[0].SystemID); gone != nil {
		t.Fatal("the grouping still exists")
	}
}

func TestUndoingAMergeOrUngroupRestoresTheSystem(t *testing.T) {
	for _, edit := range []MeaningEdit{
		{Op: MeaningMerge, SystemID: "orders", IntoSystemID: "payments"},
		{Op: MeaningUngroup, SystemID: "orders"},
	} {
		sqlDB := meaningFixture(t)
		applied, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{edit})
		must(t, err)
		_, err = UndoMeaningEvents(sqlDB, "ws", human, lastEventIDs(t, applied))
		must(t, err)
		orders, err := GetSystem(sqlDB, "orders")
		must(t, err)
		if orders == nil || orders.Name != "Orders" || orders.Source != "user" {
			t.Fatalf("%s: Orders was not restored: %+v", edit.Op, orders)
		}
		if systemOf(t, sqlDB, "cart") != "orders" || systemOf(t, sqlDB, "billing") != "orders" {
			t.Fatalf("%s: files did not come back", edit.Op)
		}
		refunds, err := GetSystem(sqlDB, "refunds")
		must(t, err)
		if refunds.ParentID == nil || *refunds.ParentID != "orders" || refunds.Depth != 1 {
			t.Fatalf("%s: child system did not come back: %+v", edit.Op, refunds)
		}
	}
}

func TestUndoingRenameAndNest(t *testing.T) {
	sqlDB := meaningFixture(t)
	applied, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningRename, SystemID: "orders", Name: "Checkout"},
		{Op: MeaningNest, SystemID: "orders", ParentID: strPtr("payments")},
	})
	must(t, err)
	_, err = UndoMeaningEvents(sqlDB, "ws", human, lastEventIDs(t, applied))
	must(t, err)
	orders, err := GetSystem(sqlDB, "orders")
	must(t, err)
	if orders.Name != "Orders" || orders.ParentID != nil || orders.Depth != 0 {
		t.Fatalf("rename and nest were not undone: %+v", orders)
	}
}

func TestOnlyMeaningEditsCanBeUndone(t *testing.T) {
	sqlDB := meaningFixture(t)
	must(t, RecordStructuralEvent(sqlDB, StructuralEvent{
		WorkspaceID: "ws", Kind: EventFileCreated, SubjectID: "cart", SubjectLabel: "cart.ts",
	}))
	events := journal(t, sqlDB)
	if _, err := UndoMeaningEvents(sqlDB, "ws", human, []int64{events[0].ID}); !errors.Is(err, ErrMeaningEdit) {
		t.Fatalf("undoing an indexer event was allowed: %v", err)
	}
}
