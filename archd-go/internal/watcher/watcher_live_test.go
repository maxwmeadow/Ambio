package watcher

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
)

// The watcher end to end: real fsnotify events on a real folder, indexed into
// a real map. Saves, new folders (whose files never fire their own event) and
// deletions all reach the map, and a settled burst runs the follow-up hook.
func TestTheWatcherKeepsTheMapInStepWithTheFolder(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	rootPath := t.TempDir()
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: rootPath, IsPrimary: true}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "live"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	w, err := New(sqlDB, hub.New(), []db.Root{root})
	if err != nil {
		t.Fatal(err)
	}
	settled := make(chan string, 8)
	w.OnSettled(func(r db.Root) { settled <- r.ID })
	go w.Run()
	t.Cleanup(func() { _ = w.Close() })

	indexed := func(rel string) bool {
		var n int
		_ = sqlDB.QueryRow(`SELECT COUNT(*) FROM files WHERE root_id = 'root' AND rel_path = ?`, rel).Scan(&n)
		return n == 1
	}
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(25 * time.Millisecond)
		}
	}
	write := func(rel, body string) {
		t.Helper()
		path := filepath.Join(rootPath, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("main.go", "package main\n\nfunc main() {}\n")
	waitFor("a saved file to be indexed", func() bool { return indexed("main.go") })

	write("pkg/store/store.go", "package store\n\nfunc Save() {}\n")
	waitFor("a file in a new folder to be indexed", func() bool { return indexed("pkg/store/store.go") })

	// Not source: never indexed.
	write("notes.bin", "\x00\x01")

	select {
	case id := <-settled:
		if id != "root" {
			t.Fatalf("settled root = %q", id)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the burst never settled")
	}

	if err := os.Remove(filepath.Join(rootPath, "main.go")); err != nil {
		t.Fatal(err)
	}
	waitFor("a deleted file to leave the map", func() bool { return !indexed("main.go") })
	if indexed("notes.bin") {
		t.Fatal("a non-source file was indexed")
	}
}
