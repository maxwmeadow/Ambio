package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

// Every change to what the architecture says - by a person or an agent -
// is one transaction with its journal rows, so it can be reviewed and undone.

var human = MeaningActor{Kind: "human"}

func meaningFixture(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	must(t, UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "shop"}))
	must(t, UpsertRoot(sqlDB, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), Branch: "main", IsPrimary: true}))
	parent := "orders"
	for _, system := range []System{
		{ID: "orders", WorkspaceID: "ws", Name: "Orders", Source: "user"},
		{ID: "payments", WorkspaceID: "ws", Name: "Payments", Source: "user"},
		{ID: "refunds", WorkspaceID: "ws", Name: "Refunds", Source: "cluster", ParentID: &parent, Depth: 1},
	} {
		must(t, UpsertSystem(sqlDB, system))
	}
	orders, refunds := "orders", "refunds"
	for _, file := range []File{
		{ID: "cart", RootID: "root", Path: "/s/cart.ts", RelPath: "cart.ts", Language: "typescript", SystemID: &orders},
		{ID: "billing", RootID: "root", Path: "/s/billing.ts", RelPath: "billing.ts", Language: "typescript", SystemID: &orders},
		{ID: "refund", RootID: "root", Path: "/s/refund.ts", RelPath: "refund.ts", Language: "typescript", SystemID: &refunds},
		{ID: "loose", RootID: "root", Path: "/s/loose.ts", RelPath: "loose.ts", Language: "typescript"},
	} {
		must(t, UpsertFile(sqlDB, file))
	}
	return sqlDB
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func systemOf(t *testing.T, sqlDB *sql.DB, fileID string) string {
	t.Helper()
	file, err := GetFileByID(sqlDB, fileID)
	must(t, err)
	if file.SystemID == nil {
		return ""
	}
	return *file.SystemID
}

func journal(t *testing.T, sqlDB *sql.DB) []StructuralEvent {
	t.Helper()
	events, err := GetStructuralEvents(sqlDB, "ws", 0)
	must(t, err)
	return events
}

func detailOf(t *testing.T, ev StructuralEvent) map[string]any {
	t.Helper()
	detail := map[string]any{}
	must(t, json.Unmarshal([]byte(ev.Detail), &detail))
	return detail
}

func TestMovingAFileIsRecordedOnceWithBothSides(t *testing.T) {
	sqlDB := meaningFixture(t)
	result, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"},
	})
	must(t, err)
	if systemOf(t, sqlDB, "billing") != "payments" || !result.Changes[0].Changed {
		t.Fatalf("billing.ts was not moved: %+v", result)
	}
	events := journal(t, sqlDB)
	if len(events) != 1 || events[0].Kind != EventFileAssigned || events[0].Actor != "human" {
		t.Fatalf("want one human file.assigned event, got %+v", events)
	}
	detail := detailOf(t, events[0])
	if detail["fromSystemName"] != "Orders" || detail["toSystemName"] != "Payments" || events[0].SubjectLabel != "billing.ts" {
		t.Fatalf("event does not say what moved where: %+v %v", events[0], detail)
	}
	if events[0].RootID != "root" || events[0].Branch != "main" {
		t.Fatalf("event lacks history identity: %+v", events[0])
	}

	// Asking for what is already true writes nothing.
	again, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"},
	})
	must(t, err)
	if again.Changes[0].Changed || len(journal(t, sqlDB)) != 1 {
		t.Fatal("a repeated assignment wrote history")
	}
}

func TestTakingAFileOutOfEverySystemClearsIt(t *testing.T) {
	sqlDB := meaningFixture(t)
	_, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"cart"}},
	})
	must(t, err)
	file, err := GetFileByID(sqlDB, "cart")
	must(t, err)
	if file.SystemID != nil {
		t.Fatalf("file still owned by %q", *file.SystemID)
	}
}

func TestPlacingAFileInAnInferredSystemAdoptsIt(t *testing.T) {
	sqlDB := meaningFixture(t)
	_, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"loose"}, SystemID: "refunds"},
	})
	must(t, err)
	refunds, err := GetSystem(sqlDB, "refunds")
	must(t, err)
	if refunds.Source != "user" {
		t.Fatalf("the clusterer could still rewrite a boundary a person used: source %q", refunds.Source)
	}
}

func TestRenameAndNestKeepTheTreeConsistent(t *testing.T) {
	sqlDB := meaningFixture(t)
	_, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningRename, SystemID: "refunds", Name: "Returns"},
		{Op: MeaningNest, SystemID: "orders", ParentID: strPtr("payments")},
	})
	must(t, err)
	returns, err := GetSystem(sqlDB, "refunds")
	must(t, err)
	if returns.Name != "Returns" || returns.Source != "user" || returns.Depth != 2 {
		t.Fatalf("renamed nested system wrong: %+v", returns)
	}
	events := journal(t, sqlDB)
	if len(events) != 2 || events[0].Kind != EventSystemRenamed || events[1].Kind != EventSystemNested {
		t.Fatalf("want rename then nest, got %+v", events)
	}
	if d := detailOf(t, events[1]); d["fromParentId"] != nil || d["toParentName"] != "Payments" {
		t.Fatalf("nest detail wrong: %v", d)
	}

	// A system cannot end up inside itself.
	_, err = ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningNest, SystemID: "payments", ParentID: strPtr("refunds")},
	})
	if !errors.Is(err, ErrMeaningEdit) {
		t.Fatalf("nesting into a descendant was allowed: %v", err)
	}
}

func TestMergeMovesEverythingInOneStep(t *testing.T) {
	sqlDB := meaningFixture(t)
	_, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningMerge, SystemID: "orders", IntoSystemID: "payments"},
	})
	must(t, err)
	if systemOf(t, sqlDB, "cart") != "payments" || systemOf(t, sqlDB, "billing") != "payments" {
		t.Fatal("files were not merged")
	}
	refunds, err := GetSystem(sqlDB, "refunds")
	must(t, err)
	if refunds.ParentID == nil || *refunds.ParentID != "payments" || refunds.Depth != 1 {
		t.Fatalf("child system was not moved: %+v", refunds)
	}
	if gone, _ := GetSystem(sqlDB, "orders"); gone != nil {
		t.Fatal("merged system still exists")
	}
	events := journal(t, sqlDB)
	if len(events) != 1 || events[0].Kind != EventSystemMerged || events[0].ObjectLabel != "Payments" {
		t.Fatalf("want one merge event, got %+v", events)
	}
	detail := detailOf(t, events[0])
	if len(detail["movedFileIds"].([]any)) != 2 || len(detail["movedSystemIds"].([]any)) != 1 {
		t.Fatalf("merge event cannot be undone from its detail: %v", detail)
	}

	_, err = ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningMerge, SystemID: "payments", IntoSystemID: "refunds"},
	})
	if !errors.Is(err, ErrMeaningEdit) {
		t.Fatalf("merging into a descendant was allowed: %v", err)
	}
}

func TestUngroupMovesContentsUpAndTouchesNoCode(t *testing.T) {
	sqlDB := meaningFixture(t)
	_, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningUngroup, SystemID: "refunds"},
	})
	must(t, err)
	if systemOf(t, sqlDB, "refund") != "orders" {
		t.Fatal("ungrouped file did not move to the parent system")
	}
	if file, _ := GetFileByID(sqlDB, "refund"); file == nil {
		t.Fatal("ungrouping deleted a file")
	}

	_, err = ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningUngroup, SystemID: "orders"},
	})
	must(t, err)
	if systemOf(t, sqlDB, "cart") != "" {
		t.Fatal("ungrouping a top-level system should leave its files unsorted")
	}
	events := journal(t, sqlDB)
	if len(events) != 2 || events[0].Kind != EventSystemUngrouped || events[0].ObjectLabel != "Orders" {
		t.Fatalf("want two ungroup events, the first into Orders: %+v", events)
	}
}

func TestABatchAppliesCompletelyOrNotAtAll(t *testing.T) {
	sqlDB := meaningFixture(t)
	_, err := ApplyMeaningEdits(sqlDB, "ws", human, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"},
		{Op: MeaningRename, SystemID: "missing", Name: "X"},
	})
	if !errors.Is(err, ErrMeaningEdit) {
		t.Fatalf("want a meaning-edit error, got %v", err)
	}
	if systemOf(t, sqlDB, "billing") != "orders" || len(journal(t, sqlDB)) != 0 {
		t.Fatal("a failed batch left part of itself behind")
	}
}

func TestAgentEditsAreAttributedAndNeverGuessed(t *testing.T) {
	sqlDB := meaningFixture(t)
	if _, err := ApplyMeaningEdits(sqlDB, "ws", MeaningActor{Kind: "agent"}, []MeaningEdit{
		{Op: MeaningRename, SystemID: "orders", Name: "Checkout"},
	}); !errors.Is(err, ErrMeaningEdit) {
		t.Fatalf("an unnamed agent was accepted: %v", err)
	}
	if _, err := ApplyMeaningEdits(sqlDB, "ws", MeaningActor{}, []MeaningEdit{
		{Op: MeaningRename, SystemID: "orders", Name: "Checkout"},
	}); !errors.Is(err, ErrMeaningEdit) {
		t.Fatalf("an edit with no actor was accepted: %v", err)
	}

	session, err := StartWorkSession(sqlDB, WorkSession{
		ID: "s-1", WorkspaceID: "ws", OwnerKey: "codex-1", Agent: "codex", Goal: "Split checkout",
		RootID: "root", Branch: "main",
	})
	must(t, err)
	result, err := ApplyMeaningEdits(sqlDB, "ws", MeaningActor{Kind: "agent", Agent: "codex", SessionID: session.ID}, []MeaningEdit{
		{Op: MeaningCreate, Name: "Checkout", ParentID: strPtr("orders"), FileIDs: []string{"cart"}},
	})
	must(t, err)
	created, err := GetSystem(sqlDB, result.Changes[0].SystemID)
	must(t, err)
	if created.Source != "agent" || created.Depth != 1 || systemOf(t, sqlDB, "cart") != created.ID {
		t.Fatalf("created system wrong: %+v", created)
	}
	events := journal(t, sqlDB)
	if len(events) != 2 || events[0].Kind != EventSystemCreated || events[1].Kind != EventFileAssigned {
		t.Fatalf("want created then assigned, got %+v", events)
	}
	for _, ev := range events {
		if ev.Actor != "agent" || ev.SessionID != "s-1" || detailOf(t, ev)["agent"] != "codex" {
			t.Fatalf("agent edit not attributed: %+v", ev)
		}
	}
}

func TestPresentationIsNotMeaning(t *testing.T) {
	sqlDB := meaningFixture(t)
	orders, err := GetSystem(sqlDB, "orders")
	must(t, err)
	orders.PositionX, orders.PositionY = 400, 220
	must(t, UpsertSystem(sqlDB, *orders))
	if len(journal(t, sqlDB)) != 0 {
		t.Fatal("moving a system on the canvas wrote history")
	}
}

func strPtr(value string) *string { return &value }
