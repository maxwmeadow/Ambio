package indexer

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
)

// Doing what the map asks - moving a file into its system's folder - must not
// cost the file its place on the map.

func movedFixture(t *testing.T) (*sql.DB, db.Root, string) {
	t.Helper()
	sqlDB, root, eventHub := journalFixture(t)
	recentRemovals = map[string][]removedFile{}
	if err := db.UpsertSystem(sqlDB, db.System{ID: "payments", WorkspaceID: "ws", Name: "Payments", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(root.Path, "orders", "billing.py")
	for _, dir := range []string{"orders", "payments"} {
		if err := os.MkdirAll(filepath.Join(root.Path, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeLivingFixture(t, oldPath, "def charge(amount):\n    return amount\n")
	if err := ReindexFile(sqlDB, eventHub, root, oldPath); err != nil {
		t.Fatal(err)
	}
	file, err := db.GetFileByRelPath(sqlDB, root.ID, "orders/billing.py")
	if err != nil || file == nil {
		t.Fatalf("fixture not indexed: %v", err)
	}
	if _, err := db.ApplyMeaningEdits(sqlDB, "ws", db.MeaningActor{Kind: "human"}, []db.MeaningEdit{
		{Op: db.MeaningAssign, FileIDs: []string{file.ID}, SystemID: "payments"},
	}); err != nil {
		t.Fatal(err)
	}
	return sqlDB, root, file.ID
}

func moveOnDisk(t *testing.T, root db.Root, from, to, content string) (string, string) {
	t.Helper()
	oldPath, newPath := filepath.Join(root.Path, from), filepath.Join(root.Path, to)
	if content == "" {
		raw, err := os.ReadFile(oldPath)
		if err != nil {
			t.Fatal(err)
		}
		content = string(raw)
	}
	writeLivingFixture(t, newPath, content)
	if err := os.Remove(oldPath); err != nil {
		t.Fatal(err)
	}
	return oldPath, newPath
}

func assertKeptItsPlace(t *testing.T, sqlDB *sql.DB, root db.Root, id, relPath string) {
	t.Helper()
	file, err := db.GetFileByRelPath(sqlDB, root.ID, relPath)
	if err != nil || file == nil {
		t.Fatalf("%s not indexed: %v", relPath, err)
	}
	if file.ID != id {
		t.Fatalf("the moved file got a new identity: %s, was %s", file.ID, id)
	}
	if file.SystemID == nil || *file.SystemID != "payments" {
		t.Fatalf("the moved file lost its system: %v", file.SystemID)
	}
	if old, _ := db.GetFileByRelPath(sqlDB, root.ID, "orders/billing.py"); old != nil {
		t.Fatal("the old path is still indexed")
	}
}

func TestAMoveSeenAsCreateThenDeleteKeepsTheFile(t *testing.T) {
	sqlDB, root, id := movedFixture(t)
	oldPath, newPath := moveOnDisk(t, root, "orders/billing.py", "payments/billing.py", "")
	if err := ReindexFile(sqlDB, hub.New(), root, newPath); err != nil {
		t.Fatal(err)
	}
	if err := RemoveFile(sqlDB, hub.New(), root, oldPath); err != nil {
		t.Fatal(err)
	}
	assertKeptItsPlace(t, sqlDB, root, id, "payments/billing.py")
}

func TestAMoveSeenAsDeleteThenCreateKeepsTheFile(t *testing.T) {
	sqlDB, root, id := movedFixture(t)
	oldPath, newPath := moveOnDisk(t, root, "orders/billing.py", "payments/billing.py", "")
	if err := RemoveFile(sqlDB, hub.New(), root, oldPath); err != nil {
		t.Fatal(err)
	}
	if err := ReindexFile(sqlDB, hub.New(), root, newPath); err != nil {
		t.Fatal(err)
	}
	assertKeptItsPlace(t, sqlDB, root, id, "payments/billing.py")
}

func TestAMoveThatAlsoEditedTheFileIsMatchedByName(t *testing.T) {
	sqlDB, root, id := movedFixture(t)
	_, newPath := moveOnDisk(t, root, "orders/billing.py", "payments/billing.py",
		"from .gateway import send\n\ndef charge(amount):\n    return send(amount)\n")
	if err := ReindexFile(sqlDB, hub.New(), root, newPath); err != nil {
		t.Fatal(err)
	}
	assertKeptItsPlace(t, sqlDB, root, id, "payments/billing.py")
}

func TestANewFileIsNotMistakenForAMove(t *testing.T) {
	sqlDB, root, id := movedFixture(t)
	newPath := filepath.Join(root.Path, "payments", "refunds.py")
	writeLivingFixture(t, newPath, "def refund(amount):\n    return -amount\n")
	if err := ReindexFile(sqlDB, hub.New(), root, newPath); err != nil {
		t.Fatal(err)
	}
	file, _ := db.GetFileByRelPath(sqlDB, root.ID, "payments/refunds.py")
	if file == nil || file.ID == id {
		t.Fatalf("a new file took over another's identity: %+v", file)
	}
	if old, _ := db.GetFileByRelPath(sqlDB, root.ID, "orders/billing.py"); old == nil {
		t.Fatal("the untouched file vanished")
	}
}
