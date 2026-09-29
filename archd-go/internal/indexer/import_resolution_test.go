package indexer

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestPythonImportResolutionUsesModulesNotDirectoryMembership(t *testing.T) {
	files := []db.File{
		{ID: "models-init", RelPath: "models/__init__.py", Language: "python"},
		{ID: "task", RelPath: "models/task.py", Language: "python"},
		{ID: "storage-init", RelPath: "storage/__init__.py", Language: "python"},
		{ID: "store", RelPath: "storage/task_store.py", Language: "python"},
		{ID: "nested", RelPath: "storage/internal/adapter.py", Language: "python"},
	}
	index := buildImportPathIndex(files)

	tests := []struct {
		name     string
		source   db.File
		imported string
		wantID   string
	}{
		{
			name:     "absolute dotted module",
			source:   db.File{RelPath: "services/task_service.py", Language: "python"},
			imported: "models.task",
			wantID:   "task",
		},
		{
			name:     "package resolves to init",
			source:   db.File{RelPath: "main.py", Language: "python"},
			imported: "models",
			wantID:   "models-init",
		},
		{
			name:     "single-dot relative module",
			source:   files[2],
			imported: ".task_store",
			wantID:   "store",
		},
		{
			name:     "double-dot relative module",
			source:   files[4],
			imported: "..task_store",
			wantID:   "store",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := resolveImportFileID(test.source, test.imported, index)
			if !ok || got != test.wantID {
				t.Fatalf("resolve %q from %q = %q, %v; want %q, true",
					test.imported, test.source.RelPath, got, ok, test.wantID)
			}
		})
	}
}

// A service folder in a monorepo is a Python source root: its package is
// imported without the folder name.
func TestPythonImportsResolveFromTheSourceRoot(t *testing.T) {
	files := []db.File{
		{ID: "pkg-init", RelPath: "worker/pantry_worker/__init__.py", Language: "python"},
		{ID: "db", RelPath: "worker/pantry_worker/db.py", Language: "python"},
		{ID: "tasks-init", RelPath: "worker/pantry_worker/tasks/__init__.py", Language: "python"},
		{ID: "receipts", RelPath: "worker/pantry_worker/tasks/receipts.py", Language: "python"},
	}
	index := buildImportPathIndex(files)
	source := db.File{RelPath: "worker/pantry_worker/consumer.py", Language: "python"}
	for imported, want := range map[string]string{
		"pantry_worker.db": "db", "pantry_worker.tasks.receipts": "receipts", "pantry_worker": "pkg-init",
	} {
		if got, ok := resolveImportFileID(source, imported, index); !ok || got != want {
			t.Errorf("%s resolves to %s, got %q", imported, want, got)
		}
	}
}

// A Go import names a package: every non-test file in its folder, found
// through the go.mod module path.
func TestGoImportsResolveToThePackageFolder(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) db.File {
		abs := filepath.Join(root, rel)
		_ = os.MkdirAll(filepath.Dir(abs), 0o755)
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return db.File{ID: rel, Path: abs, RelPath: rel, Language: "go"}
	}
	write("routing/go.mod", "module github.com/pantry/routing\n\ngo 1.22\n")
	files := []db.File{
		write("routing/cmd/routing/main.go", "package main\n"),
		write("routing/internal/store/mongo.go", "package store\n"),
		write("routing/internal/store/routes.go", "package store\n"),
		write("routing/internal/store/mongo_test.go", "package store\n"),
	}
	index := buildImportPathIndex(files)
	got := resolveImportFileIDs(files[0], "github.com/pantry/routing/internal/store", index)
	sort.Strings(got)
	if len(got) != 2 || got[0] != "routing/internal/store/mongo.go" || got[1] != "routing/internal/store/routes.go" {
		t.Errorf("the store package is its two non-test files: %v", got)
	}
	if ids := resolveImportFileIDs(files[0], "github.com/segmentio/kafka-go", index); len(ids) != 0 {
		t.Errorf("an external module resolves to nothing: %v", ids)
	}
}
