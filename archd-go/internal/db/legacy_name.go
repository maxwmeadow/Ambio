package db

import (
	"os"
	"path/filepath"
	"strings"
)

// The project was called Axiom until 2026-10 (docs/DECISIONS.md §3). Maps made
// then live in ~/.axiom with each project's database at <id>/axiom.db and its
// backups as backups/axiom-<time>.db. These helpers move them to the Ambio
// names once, so an existing map opens unchanged after the rename. Nothing is
// overwritten: when the new name already exists, the old file is left alone.

// MigrateLegacyHome moves ~/.axiom to ~/.ambio when only the old folder exists.
func MigrateLegacyHome(home string) {
	oldDir, newDir := filepath.Join(home, ".axiom"), filepath.Join(home, ".ambio")
	if _, err := os.Stat(newDir); err == nil {
		return
	}
	if info, err := os.Stat(oldDir); err == nil && info.IsDir() {
		_ = os.Rename(oldDir, newDir)
	}
}

// AdoptLegacyMaps renames every project's axiom.db (with its WAL and SHM
// files) and axiom-*.db backups under dataDir to their Ambio names.
func AdoptLegacyMaps(dataDir string) {
	projects, err := os.ReadDir(dataDir)
	if err != nil {
		return
	}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		dir := filepath.Join(dataDir, project.Name())
		renameIfFree(filepath.Join(dir, "axiom.db"), filepath.Join(dir, "ambio.db"))
		for _, suffix := range []string{"-wal", "-shm"} {
			renameIfFree(filepath.Join(dir, "axiom.db"+suffix), filepath.Join(dir, "ambio.db"+suffix))
		}
		backups, err := os.ReadDir(filepath.Join(dir, "backups"))
		if err != nil {
			continue
		}
		for _, backup := range backups {
			if name := backup.Name(); strings.HasPrefix(name, "axiom-") {
				renameIfFree(filepath.Join(dir, "backups", name), filepath.Join(dir, "backups", "ambio-"+strings.TrimPrefix(name, "axiom-")))
			}
		}
	}
}

func renameIfFree(from, to string) {
	if _, err := os.Stat(to); err == nil {
		return
	}
	if _, err := os.Stat(from); err == nil {
		_ = os.Rename(from, to)
	}
}
