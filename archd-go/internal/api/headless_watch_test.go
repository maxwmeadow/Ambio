package api

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/indexer"
	"axiom.local/archd/internal/runtime"
)

// An agent that starts archd while the app is closed gets a live map: what
// changed while nobody watched is caught up, and new saves are indexed.
func TestAProjectOpenedWithoutTheAppIsWatched(t *testing.T) {
	dataDir := t.TempDir()
	rootPath := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(rootPath, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("orders.py", "def place():\n    return 1\n")

	// A project the app indexed earlier.
	first := NewServer(dataDir, hub.New(), runtime.NewManager(hub.New()))
	sqlDB, err := first.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: rootPath, IsActive: true, IsPrimary: true}
	for _, step := range []error{
		db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}),
		db.UpsertRoot(sqlDB, root),
		indexer.IndexRoot(sqlDB, hub.New(), root, nil),
		db.MarkRootIndexed(sqlDB, root.ID, indexer.ClassifierVersion),
	} {
		if step != nil {
			t.Fatal(step)
		}
	}
	first.closeDB("ws")

	// Changed while Axiom was closed.
	write("billing.py", "def charge():\n    return 2\n")

	// An agent's daemon answers its first request.
	agent := NewServer(dataDir, hub.New(), runtime.NewManager(hub.New()))
	t.Cleanup(func() { agent.closeDB("ws") })
	if r := send(t, agent, http.MethodGet, "/api/canvas/history?workspace=ws", nil); r.Code != http.StatusOK {
		t.Fatalf("history: %d %s", r.Code, r.Body.String())
	}
	live, err := agent.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	waitForFile(t, live, "billing.py")

	// Saved while the agent works.
	time.Sleep(300 * time.Millisecond) // let the watcher attach
	write("refunds.py", "def refund():\n    return 3\n")
	waitForFile(t, live, "refunds.py")
}

func waitForFile(t *testing.T, sqlDB *sql.DB, relPath string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if file, _ := db.GetFileByRelPath(sqlDB, "root", relPath); file != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("%s was never indexed", relPath)
}
