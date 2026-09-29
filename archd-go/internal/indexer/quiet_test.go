package indexer

import (
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
)

// Excluding or re-including folders changes what Axiom reads, not the code,
// so it must never surface in the Morning Delta - while a real edit made in
// the same window still must.

func TestRescopeIsNotDriftButConcurrentEditsAre(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	vendor := filepath.Join(root.Path, "vendor")
	for _, dir := range []string{vendor, filepath.Join(root.Path, "extra")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeLivingFixture(t, filepath.Join(root.Path, "app.py"), "from vendor.lib import helper\n\ndef run():\n    return helper()\n")
	writeLivingFixture(t, filepath.Join(vendor, "lib.py"), "def helper():\n    return 1\n")
	writeLivingFixture(t, filepath.Join(root.Path, "extra", "tool.py"), "def tool():\n    return 2\n")
	excludedExtra := []string{filepath.Join(root.Path, "extra") + "/**"}
	if err := IndexRoot(sqlDB, eventHub, root, excludedExtra); err != nil {
		t.Fatal(err)
	}
	reviewed := reviewedAt(t, sqlDB)

	// While closed: the user will exclude vendor/ and include extra/, and an
	// agent edited app.py.
	writeLivingFixture(t, filepath.Join(root.Path, "app.py"), "def run():\n    return 3\n")
	excludedVendor := []string{vendor + "/**"}
	if _, err := ReconcileScope(sqlDB, eventHub, root, excludedExtra, excludedVendor); err != nil {
		t.Fatal(err)
	}

	lib, err := db.GetFileByRelPath(sqlDB, root.ID, "vendor/lib.py")
	if err != nil {
		t.Fatal(err)
	}
	if lib != nil {
		t.Fatal("the newly excluded file is still on the map")
	}
	tool, err := db.GetFileByRelPath(sqlDB, root.ID, "extra/tool.py")
	if err != nil {
		t.Fatal(err)
	}
	if tool == nil {
		t.Fatal("the newly included file never reached the map")
	}

	summary := journalSummary(t, sqlDB, reviewed)
	if summary.Counts.FilesDeleted != 0 || summary.Counts.FilesCreated != 0 {
		t.Fatalf("a scope change was journaled as files created/deleted: %+v", summary.Counts)
	}
	if summary.Counts.FilesUpdated != 1 {
		t.Fatalf("the real edit to app.py must still be in the delta: %+v", summary.Counts)
	}
	if isQuietRoot(root.ID) {
		t.Fatal("quiet scope leaked past the re-scope")
	}
}
