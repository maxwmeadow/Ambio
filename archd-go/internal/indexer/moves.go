package indexer

import (
	"database/sql"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"

	"axiom.local/archd/internal/db"
)

// File moves. A file moved on disk reaches the indexer as a delete and a
// create, in either order. Treating that as a new file would throw away what
// the map says about it - the system you put it in, its place on the Floor,
// its history - exactly when an agent is doing what the map asked ("move
// billing.ts into src/payments/"). So a new path is matched to the file that
// just disappeared and keeps its identity.
//
// A match is the same content (a plain move) or, failing that, the only
// vanished file with the same name (a move that also fixed its own imports).

// moveWindow is how long a deleted file can still be claimed by a create.
const moveWindow = 30 * time.Second

type removedFile struct {
	file     db.File
	systemID *string
	at       time.Time
}

var (
	// moveMu makes "is this a move?" and "remove this file" one step each, so
	// a delete and a create handled at the same moment cannot both miss.
	moveMu         sync.Mutex
	recentRemovals = map[string][]removedFile{} // by root ID
)

// rememberRemoval keeps a deleted file claimable for moveWindow.
func rememberRemoval(rootID string, file db.File) {
	now := time.Now()
	kept := []removedFile{{file: file, systemID: file.SystemID, at: now}}
	for _, removed := range recentRemovals[rootID] {
		if now.Sub(removed.at) < moveWindow {
			kept = append(kept, removed)
		}
	}
	recentRemovals[rootID] = kept
}

// adoptMovedFile looks for the file a new path was moved from. When the old
// row still exists (the create arrived first) it is renamed in place and
// returned; when it was already removed, the returned file carries its old
// ID and system for the new row to take. ok is false for a genuinely new file.
func adoptMovedFile(sqlDB *sql.DB, root db.Root, relPath, absPath string, existing map[string]db.File) (moved db.File, from string, ok bool) {
	hash := contentHash(absPath)
	name := path.Base(relPath)

	// The old row is still here: a known file whose path no longer exists.
	var byName []db.File
	for oldRel, file := range existing {
		sameContent := hash != "" && file.ContentHash == hash
		if oldRel == relPath || (!sameContent && path.Base(oldRel) != name) {
			continue
		}
		if _, err := os.Stat(filepath.Join(root.Path, filepath.FromSlash(oldRel))); !os.IsNotExist(err) {
			continue
		}
		if sameContent {
			return renameInPlace(sqlDB, file, relPath, absPath)
		}
		byName = append(byName, file)
	}
	if len(byName) == 1 {
		return renameInPlace(sqlDB, byName[0], relPath, absPath)
	}

	// The old row is gone: a file removed moments ago.
	var match *removedFile
	matches := 0
	removals := recentRemovals[root.ID]
	for i := range removals {
		removed := &removals[i]
		if time.Since(removed.at) >= moveWindow {
			continue
		}
		if hash != "" && removed.file.ContentHash == hash {
			match, matches = removed, 1
			break
		}
		if path.Base(removed.file.RelPath) == name {
			match = removed
			matches++
		}
	}
	if match == nil || matches != 1 {
		return db.File{}, "", false
	}
	claimed := match.file
	claimed.SystemID = match.systemID
	kept := removals[:0]
	for _, removed := range removals {
		if removed.file.ID != claimed.ID {
			kept = append(kept, removed)
		}
	}
	recentRemovals[root.ID] = kept
	return claimed, claimed.RelPath, true
}

func renameInPlace(sqlDB *sql.DB, file db.File, relPath, absPath string) (db.File, string, bool) {
	if _, err := sqlDB.Exec(`UPDATE files SET rel_path = ?, path = ? WHERE id = ?`, relPath, absPath, file.ID); err != nil {
		return db.File{}, "", false
	}
	from := file.RelPath
	file.RelPath, file.Path = relPath, absPath
	return file, from, true
}

// restoreMovedSystem gives a re-created row back the system its old self was
// in, if that system still exists and nothing has assigned it since.
func restoreMovedSystem(sqlDB *sql.DB, fileID string, systemID *string) {
	if systemID == nil {
		return
	}
	_, _ = sqlDB.Exec(`
		UPDATE files SET system_id = ?
		WHERE id = ? AND system_id IS NULL AND EXISTS (SELECT 1 FROM systems WHERE id = ?)`,
		*systemID, fileID, *systemID)
}
