package delta

import (
	"database/sql"
	"strings"
	"testing"

	"ambio.local/archd/internal/db"
)

// Review Changes reports what people and agents changed about the map as
// claims you can read and undo, collapsed to what actually differs.

func meaningDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	check := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	check(db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}))
	check(db.UpsertRoot(sqlDB, db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}))
	check(db.UpsertSystem(sqlDB, db.System{ID: "orders", WorkspaceID: "ws", Name: "Orders", Source: "user"}))
	check(db.UpsertSystem(sqlDB, db.System{ID: "payments", WorkspaceID: "ws", Name: "Payments", Source: "user"}))
	orders := "orders"
	for _, file := range []db.File{
		{ID: "billing", RootID: "root", Path: "/s/billing.ts", RelPath: "billing.ts", Language: "typescript", SystemID: &orders},
		{ID: "cart", RootID: "root", Path: "/s/cart.ts", RelPath: "cart.ts", Language: "typescript", SystemID: &orders},
	} {
		check(db.UpsertFile(sqlDB, file))
	}
	return sqlDB
}

func reviewOf(t *testing.T, sqlDB *sql.DB) Summary {
	t.Helper()
	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	summary := Aggregate(events, 0, 1<<62)
	summary.Claims = BuildClaims(summary, nil)
	return summary
}

func apply(t *testing.T, sqlDB *sql.DB, actor db.MeaningActor, edits ...db.MeaningEdit) db.MeaningResult {
	t.Helper()
	result, err := db.ApplyMeaningEdits(sqlDB, "ws", actor, edits)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

var you = db.MeaningActor{Kind: "human"}

func meaningClaimsIn(summary Summary) []Claim {
	out := []Claim{}
	for _, claim := range summary.Claims {
		if strings.HasPrefix(string(claim.Kind), "meaning.") {
			out = append(out, claim)
		}
	}
	return out
}

func TestAMoveReadsAsOneUndoableClaim(t *testing.T) {
	sqlDB := meaningDB(t)
	apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"})
	claims := meaningClaimsIn(reviewOf(t, sqlDB))
	if len(claims) != 1 {
		t.Fatalf("want one claim, got %+v", claims)
	}
	claim := claims[0]
	if claim.Title != "billing.ts moved from Orders to Payments" || claim.Subtitle != "by you" {
		t.Fatalf("claim reads %q / %q", claim.Title, claim.Subtitle)
	}
	if len(claim.UndoEventIDs) != 1 {
		t.Fatalf("claim cannot be undone: %+v", claim)
	}
}

func TestChangingYourMindLeavesNothingToReview(t *testing.T) {
	sqlDB := meaningDB(t)
	// There and back by hand.
	apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningAssign, FileIDs: []string{"billing"}, SystemID: "payments"})
	apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningAssign, FileIDs: []string{"billing"}, SystemID: "orders"})
	apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningRename, SystemID: "orders", Name: "Checkout"})
	apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningRename, SystemID: "orders", Name: "Orders"})
	// And through undo.
	merged := apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningMerge, SystemID: "orders", IntoSystemID: "payments"})
	if _, err := db.UndoMeaningEvents(sqlDB, "ws", you, merged.Changes[0].EventIDs); err != nil {
		t.Fatal(err)
	}
	if claims := meaningClaimsIn(reviewOf(t, sqlDB)); len(claims) != 0 {
		t.Fatalf("net-zero changes produced claims: %+v", claims)
	}
}

func TestAnAgentsGroupingIsOneClaimWithItsFiles(t *testing.T) {
	sqlDB := meaningDB(t)
	apply(t, sqlDB, db.MeaningActor{Kind: "agent", Agent: "codex"}, db.MeaningEdit{
		Op: db.MeaningCreate, Name: "Checkout", FileIDs: []string{"cart", "billing"},
	})
	summary := reviewOf(t, sqlDB)
	claims := meaningClaimsIn(summary)
	if len(claims) != 1 || claims[0].Kind != ClaimGrouped {
		t.Fatalf("want one grouping claim, got %+v", claims)
	}
	if claims[0].Title != "New system · Checkout, grouping 2 files" || claims[0].Subtitle != "by codex" {
		t.Fatalf("claim reads %q / %q", claims[0].Title, claims[0].Subtitle)
	}
	if len(claims[0].UndoEventIDs) != 3 || len(claims[0].Evidence) != 2 {
		t.Fatalf("grouping must undo the creation and both moves: %+v", claims[0])
	}
	for _, claim := range summary.Claims {
		if claim.Kind == ClaimSystemAdded {
			t.Fatal("the grouping was also reported as a classifier birth")
		}
	}
}

func TestMergeAndUngroupClaims(t *testing.T) {
	sqlDB := meaningDB(t)
	apply(t, sqlDB, you, db.MeaningEdit{Op: db.MeaningMerge, SystemID: "orders", IntoSystemID: "payments"})
	claims := meaningClaimsIn(reviewOf(t, sqlDB))
	if len(claims) != 1 || claims[0].Title != "Orders merged into Payments" || len(claims[0].UndoEventIDs) != 1 {
		t.Fatalf("merge claim wrong: %+v", claims)
	}
}
