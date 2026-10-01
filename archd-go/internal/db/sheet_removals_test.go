package db

import (
	"database/sql"
	"errors"
	"testing"
)

// A sheet can say "this should go away". The proposal never touches reality,
// stays listed until restored, and is done only once the code is gone.

func removalFixture(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB := fitFixture(t)
	must(t, CreateSheet(sqlDB, &Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Retire billing"}))
	return sqlDB
}

func removalDiffs(t *testing.T, sqlDB *sql.DB) []SheetDifference {
	t.Helper()
	comparison, err := CompareSheetStructure(sqlDB, "ws", "sheet")
	must(t, err)
	out := []SheetDifference{}
	for _, difference := range comparison.Differences {
		if difference.Kind == "removal" {
			out = append(out, difference)
		}
	}
	return out
}

func TestAProposedFileRemovalIsOpenUntilTheFileIsGone(t *testing.T) {
	sqlDB := removalFixture(t)
	before, _ := GetSheet(sqlDB, "sheet")
	removal, err := ProposeSheetRemoval(sqlDB, "ws", "sheet", "billing", "user")
	must(t, err)
	if removal.Label != "src/orders/billing.ts" || removal.NodeType != "file" || removal.Done {
		t.Fatalf("removal = %+v", removal)
	}
	if after, _ := GetSheet(sqlDB, "sheet"); after.Revision != before.Revision+1 {
		t.Fatalf("proposing a removal did not change the sheet's revision: %d → %d", before.Revision, after.Revision)
	}
	// Nothing real happened.
	if file, _ := GetFileByRelPath(sqlDB, "root", "src/orders/billing.ts"); file == nil {
		t.Fatal("a proposal touched reality")
	}
	if diffs := removalDiffs(t, sqlDB); len(diffs) != 1 || diffs[0].NodeID != "billing" {
		t.Fatalf("want one open removal, got %+v", diffs)
	}

	must(t, DeleteFileByID(sqlDB, "billing"))
	removals, err := GetSheetRemovals(sqlDB, "ws", "sheet")
	must(t, err)
	if len(removals) != 1 || !removals[0].Done || removals[0].Label != "src/orders/billing.ts" {
		t.Fatalf("a realized removal must stay listed and marked done: %+v", removals)
	}
	if diffs := removalDiffs(t, sqlDB); len(diffs) != 0 {
		t.Fatalf("a realized removal is still open: %+v", diffs)
	}
}

func TestASystemRemovalIsDoneWhenItsCodeIsGone(t *testing.T) {
	sqlDB := removalFixture(t)
	_, err := ProposeSheetRemoval(sqlDB, "ws", "sheet", "payments", "agent")
	must(t, err)
	if diffs := removalDiffs(t, sqlDB); len(diffs) != 1 {
		t.Fatalf("want an open system removal, got %+v", diffs)
	}
	must(t, DeleteFileByID(sqlDB, "stripe"))
	must(t, DeleteFileByID(sqlDB, "invoice"))
	if diffs := removalDiffs(t, sqlDB); len(diffs) != 0 {
		t.Fatalf("an empty system still counts as code: %+v", diffs)
	}
}

func TestRemovalWinsOverAMoveAndCanBeRestored(t *testing.T) {
	sqlDB := removalFixture(t)
	// The sheet also places billing.ts somewhere; removing it drops that requirement.
	must(t, AddSheetElement(sqlDB, &SheetElement{SheetID: "sheet", FileID: strPtr("billing"), Label: "billing.ts", ParentSystemID: strPtr("payments")}))
	_, err := ProposeSheetRemoval(sqlDB, "ws", "sheet", "billing", "user")
	must(t, err)
	comparison, err := CompareSheetStructure(sqlDB, "ws", "sheet")
	must(t, err)
	for _, difference := range comparison.Differences {
		if difference.NodeID == "billing" && difference.Kind != "removal" {
			t.Fatalf("a removed node is still checked for its place: %+v", difference)
		}
	}

	must(t, RestoreSheetRemoval(sqlDB, "ws", "sheet", "billing"))
	if diffs := removalDiffs(t, sqlDB); len(diffs) != 0 {
		t.Fatalf("restored removal still open: %+v", diffs)
	}
	if err := RestoreSheetRemoval(sqlDB, "ws", "sheet", "billing"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("restoring twice: %v", err)
	}
	if _, err := ProposeSheetRemoval(sqlDB, "ws", "sheet", "nope", "user"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("removing something that does not exist: %v", err)
	}
}

// "Orders should depend on Payments" is satisfied by the code the way code
// depends: a file in Orders importing a file in Payments.
func TestAProposedDependencyBetweenSystemsIsMetByTheirFiles(t *testing.T) {
	sqlDB := removalFixture(t)
	must(t, UpsertPlannedEdge(sqlDB, &PlannedEdge{
		SheetID: "sheet", WorkspaceID: "ws", Kind: "DEPENDS_ON", SrcLive: strPtr("orders"), DstLive: strPtr("payments"),
	}))
	relationships := func() int {
		comparison, err := CompareSheetStructure(sqlDB, "ws", "sheet")
		must(t, err)
		count := 0
		for _, difference := range comparison.Differences {
			if difference.Kind == "relationship" {
				count++
			}
		}
		return count
	}
	if relationships() != 1 {
		t.Fatal("the dependency should be open before any code exists")
	}
	imports(t, sqlDB, [2]string{"stripe", "cart"}) // the wrong direction does not count
	if relationships() != 1 {
		t.Fatal("Payments → Orders satisfied Orders → Payments")
	}
	imports(t, sqlDB, [2]string{"cart", "stripe"})
	if relationships() != 0 {
		t.Fatal("cart.ts importing stripe.ts did not satisfy Orders depends on Payments")
	}
}
