package db

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMapsMadeBeforeTheRenameOpenUnderTheNewNames(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, ".axiom", "data", "ws1")
	if err := os.MkdirAll(filepath.Join(project, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"axiom.db":                         "map",
		"axiom.db-wal":                     "wal",
		"backups/axiom-20261001-090000.db": "backup",
	} {
		if err := os.WriteFile(filepath.Join(project, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	MigrateLegacyHome(home)
	dataDir := filepath.Join(home, ".ambio", "data")
	AdoptLegacyMaps(dataDir)

	moved := filepath.Join(dataDir, "ws1")
	for name, want := range map[string]string{
		"ambio.db":                         "map",
		"ambio.db-wal":                     "wal",
		"backups/ambio-20261001-090000.db": "backup",
	} {
		got, err := os.ReadFile(filepath.Join(moved, filepath.FromSlash(name)))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".axiom")); !os.IsNotExist(err) {
		t.Fatal("the old folder is still there")
	}

	// Never overwrite: a second run, or a folder that already has the new
	// name, leaves everything as it is.
	if err := os.WriteFile(filepath.Join(moved, "axiom.db"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	AdoptLegacyMaps(dataDir)
	if got, _ := os.ReadFile(filepath.Join(moved, "ambio.db")); string(got) != "map" {
		t.Fatalf("an existing ambio.db was overwritten: %q", got)
	}
	if err := os.MkdirAll(filepath.Join(home, ".axiom"), 0o755); err != nil {
		t.Fatal(err)
	}
	MigrateLegacyHome(home)
	if _, err := os.Stat(filepath.Join(home, ".axiom")); err != nil {
		t.Fatal("an old folder was moved over an existing ~/.ambio")
	}
}
