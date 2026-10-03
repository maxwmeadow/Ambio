package db

import (
	"database/sql"
	"strings"
	"testing"
)

// After you move a file on the map, Ambio says whether the code agrees, and
// stays quiet when it does.

func fitFixture(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	must(t, UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "shop"}))
	must(t, UpsertRoot(sqlDB, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}))
	for _, system := range []System{
		{ID: "orders", WorkspaceID: "ws", Name: "Orders", Source: "user"},
		{ID: "payments", WorkspaceID: "ws", Name: "Payments", Source: "user"},
		{ID: "shared", WorkspaceID: "ws", Name: "Shared", Source: "user"},
	} {
		must(t, UpsertSystem(sqlDB, system))
	}
	orders, payments, shared := "orders", "payments", "shared"
	for _, file := range []File{
		{ID: "cart", RelPath: "src/orders/cart.ts", SystemID: &orders},
		{ID: "checkout", RelPath: "src/orders/checkout.ts", SystemID: &orders},
		{ID: "pricing", RelPath: "src/orders/pricing.ts", SystemID: &orders},
		{ID: "billing", RelPath: "src/orders/billing.ts", SystemID: &orders},
		{ID: "stripe", RelPath: "src/payments/stripe.ts", SystemID: &payments},
		{ID: "invoice", RelPath: "src/payments/invoice.ts", SystemID: &payments},
		{ID: "log", RelPath: "src/lib/log.ts", SystemID: &shared},
		{ID: "ui", RelPath: "web/button.tsx", SystemID: &shared},
	} {
		file.RootID, file.Path, file.Language = "root", "/s/"+file.RelPath, "typescript"
		must(t, UpsertFile(sqlDB, file))
	}
	return sqlDB
}

func imports(t *testing.T, sqlDB *sql.DB, pairs ...[2]string) {
	t.Helper()
	for _, pair := range pairs {
		must(t, UpsertDependency(sqlDB, Dependency{
			ID: pair[0] + "->" + pair[1], WorkspaceID: "ws", Src: pair[0], Dst: pair[1],
			SrcType: "file", DstType: "file", DependencyType: "IMPORTS", Weight: 1, CreatedBy: "parser",
		}))
	}
}

func fitAfterMove(t *testing.T, sqlDB *sql.DB, fileID, systemID string) []CodeFitFinding {
	t.Helper()
	_, err := ApplyMeaningEdits(sqlDB, "ws", MeaningActor{Kind: "human"}, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{fileID}, SystemID: systemID},
	})
	must(t, err)
	findings, err := CodeFit(sqlDB, "ws", []string{fileID})
	must(t, err)
	return findings
}

func TestAFileOutsideItsSystemsFolderIsReported(t *testing.T) {
	sqlDB := fitFixture(t)
	findings := fitAfterMove(t, sqlDB, "billing", "payments")
	if len(findings) != 1 || findings[0].Kind != CodeFitFolder {
		t.Fatalf("want one folder finding, got %+v", findings)
	}
	got := findings[0]
	if got.SuggestedPath != "src/payments/billing.ts" ||
		got.Summary != "billing.ts belongs to Payments, but the rest of Payments is in src/payments/" {
		t.Fatalf("finding reads %+v", got)
	}
	if !strings.Contains(got.Ask, "Move src/orders/billing.ts to src/payments/billing.ts") {
		t.Fatalf("ask = %q", got.Ask)
	}
}

func TestAFileStillTiedToItsOldSystemIsReported(t *testing.T) {
	sqlDB := fitFixture(t)
	imports(t, sqlDB,
		[2]string{"billing", "cart"}, [2]string{"billing", "pricing"},
		[2]string{"checkout", "billing"}, [2]string{"billing", "stripe"})
	findings := fitAfterMove(t, sqlDB, "billing", "payments")
	var coupling *CodeFitFinding
	for i := range findings {
		if findings[i].Kind == CodeFitCoupling {
			coupling = &findings[i]
		}
	}
	if coupling == nil {
		t.Fatalf("no coupling finding: %+v", findings)
	}
	if coupling.OtherSystemName != "Orders" || coupling.OtherEdges != 3 || coupling.TotalEdges != 4 {
		t.Fatalf("coupling reads %+v", coupling)
	}
	if strings.Join(coupling.OtherFiles, ",") != "src/orders/cart.ts,src/orders/checkout.ts,src/orders/pricing.ts" {
		t.Fatalf("other files = %v", coupling.OtherFiles)
	}
}

func TestCodeThatAgreesIsLeftAlone(t *testing.T) {
	sqlDB := fitFixture(t)
	imports(t, sqlDB, [2]string{"stripe", "invoice"}, [2]string{"invoice", "log"})
	// Moving a file into the system whose folder it already lives in.
	if findings := fitAfterMove(t, sqlDB, "stripe", "orders"); len(findings) == 0 {
		t.Fatal("setup: moving stripe.ts to Orders should disagree")
	}
	if findings := fitAfterMove(t, sqlDB, "stripe", "payments"); len(findings) != 0 {
		t.Fatalf("moving it back should agree, got %+v", findings)
	}
	// A system spread across the tree has no home folder to report against.
	if findings := fitAfterMove(t, sqlDB, "cart", "shared"); len(findings) != 0 {
		t.Fatalf("a system with no home folder reported one: %+v", findings)
	}
}

func TestHomeFolder(t *testing.T) {
	for _, tc := range []struct {
		paths []string
		want  string
	}{
		{[]string{"src/a/x.ts", "src/a/y.ts", "src/a/z/w.ts"}, "src/a"},
		{[]string{"src/a/x.ts", "src/a/y.ts", "lib/z.ts"}, "src/a"},
		{[]string{"src/a/x.ts", "lib/y.ts", "web/z.ts"}, ""},
		{[]string{"x.ts", "y.ts"}, ""},
		{[]string{"src/a/x.ts"}, ""},
	} {
		if got := homeFolder(tc.paths); got != tc.want {
			t.Errorf("homeFolder(%v) = %q, want %q", tc.paths, got, tc.want)
		}
	}
}
