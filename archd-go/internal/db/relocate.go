package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// RebasePath moves one absolute path from under oldRoot to under newRoot. A
// path outside oldRoot is returned unchanged. Separators are compared in slash
// form so a Windows-style record still rebases on the host that wrote it.
func RebasePath(path, oldRoot, newRoot string) string {
	oldSlash := strings.TrimSuffix(filepath.ToSlash(oldRoot), "/")
	pathSlash := filepath.ToSlash(path)
	if pathSlash == oldSlash {
		return newRoot
	}
	if !strings.HasPrefix(pathSlash, oldSlash+"/") {
		return path
	}
	// Keep the suffix verbatim: exclusion globs such as "/**" must not be cleaned.
	return strings.TrimRight(newRoot, `/\`) + path[len(oldSlash):]
}

// RelocateRoot records that a root's folder now lives at newPath. The root
// keeps its id, so every system, placement, layout and journal entry keyed to
// it survives the move. Files keep their relative paths; only the absolute
// paths derived from the root are rewritten.
func RelocateRoot(sqlDB *sql.DB, rootID, oldPath, newPath string) error {
	tx, err := sqlDB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit

	var ignoredJSON string
	if err := tx.QueryRow(`SELECT ignored_paths_json FROM roots WHERE id=?`, rootID).Scan(&ignoredJSON); err != nil {
		return fmt.Errorf("read root %s: %w", rootID, err)
	}
	var ignored []string
	if err := json.Unmarshal([]byte(ignoredJSON), &ignored); err != nil {
		return fmt.Errorf("decode ignored paths for root %s: %w", rootID, err)
	}
	for i, pattern := range ignored {
		ignored[i] = RebasePath(pattern, oldPath, newPath)
	}
	rebased, err := json.Marshal(ignored)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE roots SET path=?, ignored_paths_json=? WHERE id=?`, newPath, string(rebased), rootID); err != nil {
		return err
	}

	rows, err := tx.Query(`SELECT id, rel_path FROM files WHERE root_id=?`, rootID)
	if err != nil {
		return err
	}
	type fileRow struct{ id, rel string }
	var files []fileRow
	for rows.Next() {
		var f fileRow
		if err := rows.Scan(&f.id, &f.rel); err != nil {
			rows.Close()
			return err
		}
		files = append(files, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, f := range files {
		if _, err := tx.Exec(`UPDATE files SET path=? WHERE id=?`, filepath.Join(newPath, filepath.FromSlash(f.rel)), f.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
