package indexer

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ambio.local/archd/internal/db"
)

func writeBatchFile(t *testing.T, root db.Root, rel, content string) string {
	t.Helper()
	path := filepath.Join(root.Path, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A checkout replaces many files at once: some edited, some gone, some new.
// The batch must leave the map exactly as a fresh index of the folder would.
func TestReindexBatchMatchesAFreshIndex(t *testing.T) {
	sqlDB, root, h := journalFixture(t)
	writeBatchFile(t, root, "src/store.ts", "export function save() { return 1 }\n")
	writeBatchFile(t, root, "src/api.ts", "import { save } from './store'\nimport { save as again } from './store'\nexport function handle() { return save() + again() }\n")
	old := writeBatchFile(t, root, "src/legacy.ts", "export function legacy() { return 2 }\n")
	writeBatchFile(t, root, "src/ui.ts", "import { legacy } from './legacy'\nexport function render() { return legacy() }\n")
	// Untouched by the checkout, but what they import appears and vanishes.
	writeBatchFile(t, root, "src/early.ts", "import { fresh } from './fresh'\nexport function early() { return fresh() }\n")
	writeBatchFile(t, root, "src/stale.ts", "import { legacy } from './legacy'\nexport function stale() { return legacy() }\n")
	if err := IndexRoot(sqlDB, h, root, nil); err != nil {
		t.Fatal(err)
	}

	// The other branch: legacy.ts is gone, ui.ts uses a new module.
	if err := os.Remove(old); err != nil {
		t.Fatal(err)
	}
	changed := []string{
		writeBatchFile(t, root, "src/ui.ts", "import { fresh } from './fresh'\nexport function render() { return fresh() }\n"),
		writeBatchFile(t, root, "src/fresh.ts", "export function fresh() { return 3 }\n"),
		writeBatchFile(t, root, "src/deep/nested.ts", "import { save } from '../store'\nexport function nested() { return save() }\n"),
	}
	count, err := ReindexBatch(sqlDB, h, root, changed, []string{old})
	if err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Errorf("count = %d, want 4", count)
	}

	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	byID := map[string]string{}
	for _, file := range files {
		paths = append(paths, file.RelPath)
		byID[file.ID] = file.RelPath
	}
	sort.Strings(paths)
	if want := []string{"src/api.ts", "src/deep/nested.ts", "src/early.ts", "src/fresh.ts", "src/stale.ts", "src/store.ts", "src/ui.ts"}; !equalStrings(paths, want) {
		t.Fatalf("files = %v, want %v", paths, want)
	}
	edges := importEdges(t, sqlDB, root)
	for _, want := range []string{"src/api.ts -> src/store.ts", "src/deep/nested.ts -> src/store.ts", "src/early.ts -> src/fresh.ts", "src/ui.ts -> src/fresh.ts"} {
		if !strings.Contains(strings.Join(edges, "\n"), want+" ") {
			t.Errorf("imports = %v, want %s", edges, want)
		}
	}

	// Weights included: each import counts once, as a fresh index counts it.
	freshDB, freshRoot, freshHub := journalFixture(t)
	freshRoot.Path = root.Path
	if err := db.UpsertRoot(freshDB, freshRoot); err != nil {
		t.Fatal(err)
	}
	if err := IndexRoot(freshDB, freshHub, freshRoot, nil); err != nil {
		t.Fatal(err)
	}
	if want := importEdges(t, freshDB, freshRoot); !equalStrings(edges, want) {
		t.Fatalf("imports = %v, a fresh index has %v", edges, want)
	}
}

func importEdges(t *testing.T, sqlDB *sql.DB, root db.Root) []string {
	t.Helper()
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]string{}
	for _, file := range files {
		byID[file.ID] = file.RelPath
	}
	deps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	var edges []string
	for _, dep := range deps {
		edges = append(edges, fmt.Sprintf("%s -> %s ×%d", byID[dep.Src], byID[dep.Dst], dep.Weight))
	}
	sort.Strings(edges)
	return edges
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A call reaches code its language can call, in its own repository unless
// it imports the file: a TypeScript call never resolves to a Java method of
// the same name, nor one repository to another it does not import.
func TestCallsStayInTheirLanguageAndRepository(t *testing.T) {
	sqlDB, root, h := journalFixture(t)
	for _, repository := range []string{"web", "api"} {
		if err := os.MkdirAll(filepath.Join(root.Path, repository, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		writeBatchFile(t, root, repository+"/.git/HEAD", "ref: refs/heads/main\n")
	}
	writeBatchFile(t, root, "web/src/view.ts", "export function paint() { return shade() + stamp() }\n")
	writeBatchFile(t, root, "api/tools/Shade.java", "class Shade { int shade() { return 1; } }\n")
	writeBatchFile(t, root, "api/src/stamp.ts", "export function stamp() { return 2 }\n")
	writeBatchFile(t, root, "web/src/brush.ts", "export function brush() { return paint() }\n")
	if err := IndexRoot(sqlDB, h, root, nil); err != nil {
		t.Fatal(err)
	}
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]string{}
	for _, file := range files {
		byID[file.ID] = file.RelPath
	}
	calls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, call := range calls {
		got = append(got, byID[call.CallerFile]+" -> "+byID[call.CalleeFile])
	}
	sort.Strings(got)
	if want := []string{"web/src/brush.ts -> web/src/view.ts"}; !equalStrings(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
}

// Classification waits for a batch under way: run against a branch switch
// half read in, it drew the new files unclassified beside their systems.
func TestClassificationWaitsForTheBatch(t *testing.T) {
	sqlDB, root, _ := journalFixture(t)
	release := lockRoot(root.ID)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := ClusterLive(sqlDB, root); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-done:
		release()
		t.Fatal("classification ran while the root was locked")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	<-done
}
