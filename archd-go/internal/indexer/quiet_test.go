package indexer

import (
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestReindexInPlaceCatchesWhatTimestampsHidAndNothingElse(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	target := filepath.Join(root.Path, "calc.py")
	writeLivingFixture(t, target, "def add(a, b):\n    return a + b\n")
	writeLivingFixture(t, filepath.Join(root.Path, "other.py"), "def other():\n    return 1\n")
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}
	reviewed := reviewedAt(t, sqlDB)
	// The first re-read records content hashes quietly: before it, nothing
	// can tell an edit from an untouched file.
	if _, err := ReindexRootInPlace(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}
	if summary := journalSummary(t, sqlDB, reviewed); summary.Counts.FilesUpdated != 0 {
		t.Fatalf("establishing hashes must not read as edits: %+v", summary.Counts)
	}

	// A change the watcher missed, with a timestamp that hides it (restored
	// from a backup, a checkout that preserved mtimes, a network drive).
	past := time.Now().Add(-48 * time.Hour)
	writeLivingFixture(t, target, "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n")
	if err := os.Chtimes(target, past, past); err != nil {
		t.Fatal(err)
	}
	if changed, err := ReconcileRoot(sqlDB, eventHub, root, nil); err != nil || changed != 0 {
		t.Fatalf("the ordinary catch-up should not see it: changed=%d err=%v", changed, err)
	}
	changed, err := ReindexRootInPlace(sqlDB, eventHub, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 2 {
		t.Fatalf("re-index should re-read every file: changed=%d", changed)
	}
	summary := journalSummary(t, sqlDB, reviewed)
	if summary.Counts.FilesUpdated != 1 || summary.Counts.FilesCreated != 0 || summary.Counts.FilesDeleted != 0 {
		t.Fatalf("only the real change belongs in the delta: %+v", summary.Counts)
	}
}
