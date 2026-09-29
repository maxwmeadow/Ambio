package indexer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestGeneratedAndOversizedFilesAreNotIndexed(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, size int) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Repeat("x", size)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("app.ts", 100)
	write("bundle.ts", MaxSourceFileBytes+1)
	write("vendor.min.js", 100)

	paths, err := collectSourcePaths(db.Root{Path: dir}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || filepath.Base(paths[0]) != "app.ts" {
		t.Fatalf("collected %v, want only app.ts", paths)
	}
}
