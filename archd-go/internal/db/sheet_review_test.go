package db

import "testing"

func TestSheetReviewIsAtomicScopedAndRevisionBound(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Replay"}
	if err := CreateSheet(database, &sheet); err != nil {
		t.Fatal(err)
	}
	parentID := "planned:tool"
	for _, node := range []PlannedNode{
		{ID: "tool", SheetID: "sheet", WorkspaceID: "ws", Kind: "system", Name: "Replay tool", CreatedBy: "agent"},
		{ID: "cli", SheetID: "sheet", WorkspaceID: "ws", Kind: "file", Name: "CLI", ParentSystemID: &parentID, CreatedBy: "agent"},
	} {
		if err := UpsertPlannedNode(database, &node); err != nil {
			t.Fatal(err)
		}
	}
	source, target := "cli", "tool"
	edge := PlannedEdge{ID: "edge", SheetID: "sheet", WorkspaceID: "ws", SrcPlanned: &source, DstPlanned: &target, CreatedBy: "agent"}
	if err := UpsertPlannedEdge(database, &edge); err != nil {
		t.Fatal(err)
	}
	current, _ := GetSheet(database, "sheet")
	choices := []SheetProposalChoice{{Kind: "addition", ID: "tool"}, {Kind: "addition", ID: "cli"}, {Kind: "relationship", ID: "edge"}}
	for _, attempt := range []struct {
		workspace string
		revision  int
		choices   []SheetProposalChoice
	}{
		{"other", current.Revision, choices},
		{"ws", current.Revision - 1, choices},
		{"ws", current.Revision, append(append([]SheetProposalChoice{}, choices...), SheetProposalChoice{Kind: "addition", ID: "missing"})},
		{"ws", current.Revision, []SheetProposalChoice{{Kind: "addition", ID: "cli"}}},
	} {
		if _, err := DecideSheetProposals(database, attempt.workspace, "sheet", attempt.revision, attempt.choices, "approved", ""); err == nil {
			t.Fatal("invalid partial/stale/cross-project decision succeeded")
		}
		node, _ := GetPlannedNode(database, "tool")
		if node.ApprovalStatus != "pending" {
			t.Fatal("failed batch partially approved the plan")
		}
	}
	result, err := DecideSheetProposals(database, "ws", "sheet", current.Revision, choices, "approved", "Looks good")
	if err != nil {
		t.Fatal(err)
	}
	nextRevision := result.Sheet.Revision
	if nextRevision <= current.Revision {
		t.Fatal("review did not advance the revision")
	}
	for _, id := range []string{"tool", "cli"} {
		node, _ := GetPlannedNode(database, id)
		if node.ApprovalStatus != "approved" {
			t.Fatalf("%s not approved", id)
		}
	}
	edges, _ := GetPlannedEdges(database, "sheet")
	if edges[0].ApprovalStatus != "approved" {
		t.Fatal("connection not approved")
	}
	var decisions int
	if err := database.QueryRow(`SELECT COUNT(*) FROM structural_events WHERE kind=?`, EventProposalDecided).Scan(&decisions); err != nil || decisions != 3 {
		t.Fatalf("expected three durable human decisions, got %d: %v", decisions, err)
	}
	if _, err := DecideSheetProposals(database, "ws", "sheet", nextRevision, choices, "rejected", ""); err == nil {
		t.Fatal("final decisions were reversed")
	}
}

func TestSheetReviewCannotLeaveAnApprovedChildWithoutItsParent(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	_ = UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"})
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Replay"}
	_ = CreateSheet(database, &sheet)
	parentID := "planned:tool"
	parent := PlannedNode{ID: "tool", SheetID: "sheet", WorkspaceID: "ws", Kind: "system", Name: "Tool", CreatedBy: "agent"}
	child := PlannedNode{ID: "cli", SheetID: "sheet", WorkspaceID: "ws", Kind: "file", Name: "CLI", ParentSystemID: &parentID, ApprovalStatus: "approved"}
	if err := UpsertPlannedNode(database, &parent); err != nil {
		t.Fatal(err)
	}
	if err := UpsertPlannedNode(database, &child); err != nil {
		t.Fatal(err)
	}
	current, _ := GetSheet(database, "sheet")
	if _, err := DecideSheetProposals(database, "ws", "sheet", current.Revision, []SheetProposalChoice{{Kind: "addition", ID: "tool"}}, "rejected", "Move it elsewhere"); err == nil {
		t.Fatal("rejected parent of an approved child")
	}
	loaded, err := GetPlannedNode(database, parent.ID)
	if err != nil || loaded.ApprovalStatus != "pending" {
		t.Fatal("failed rejection changed the parent")
	}
}
