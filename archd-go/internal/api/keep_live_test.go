package api

import (
	"os"
	"path/filepath"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	ambioruntime "ambio.local/archd/internal/runtime"
)

// A project opened by a request starts watching in the background. Deleting
// it right away must not race that start: nothing may write into the
// project's folder once it is closed.
func TestDeletingAProjectJustOpenedByARequestLeavesNothingBehind(t *testing.T) {
	for i := 0; i < 30; i++ {
		dataDir := t.TempDir()
		projectDir := filepath.Join(dataDir, "ws")
		sqlDB, err := db.Open(projectDir)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "headless"}); err != nil {
			t.Fatal(err)
		}
		rootPath := t.TempDir()
		if err := os.WriteFile(filepath.Join(rootPath, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		root := db.Root{ID: "root", WorkspaceID: "ws", Path: rootPath, IsActive: true}
		if err := db.UpsertRoot(sqlDB, root); err != nil {
			t.Fatal(err)
		}
		if err := db.MarkRootIndexed(sqlDB, root.ID, 3); err != nil {
			t.Fatal(err)
		}
		if err := sqlDB.Close(); err != nil {
			t.Fatal(err)
		}

		eventHub := hub.New()
		server := NewServer(dataDir, eventHub, ambioruntime.NewManager(eventHub))
		if _, err := server.dbFor("ws"); err != nil {
			t.Fatal(err)
		}
		if err := server.deleteWorkspace("ws"); err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
	}
}
