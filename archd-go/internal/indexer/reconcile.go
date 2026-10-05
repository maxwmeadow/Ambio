package indexer

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
)

// collectSourcePaths walks a root and returns every indexable source file,
// honouring both the built-in skip list and the user's source boundaries.
func collectSourcePaths(root db.Root, ignoredPaths []string) ([]string, error) {
	ignoredAbsDirs := make(map[string]bool)
	for _, p := range ignoredPaths {
		native := filepath.FromSlash(p)
		native = strings.TrimSuffix(native, string(filepath.Separator)+"**")
		native = strings.TrimSuffix(native, "/**")
		clean := filepath.Clean(native)
		if clean != "" && clean != "." {
			key := strings.ToLower(clean)
			ignoredAbsDirs[key] = true
			log.Printf("[indexer] will ignore: %q (key=%q)", p, key)
		}
	}
	isIgnored := func(absPath string) bool {
		hit := ignoredAbsDirs[strings.ToLower(absPath)]
		if hit {
			log.Printf("[indexer] skipping dir: %s", absPath)
		}
		return hit
	}

	var paths []string
	skipped := 0
	err := filepath.WalkDir(root.Path, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable dirs
		}
		if d.IsDir() {
			if skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") || isIgnored(path) {
				return filepath.SkipDir
			}
			return nil
		}
		if IsSupportedSourceFile(path) {
			if tooLargeOrGenerated(path, d) {
				skipped++
				return nil
			}
			paths = append(paths, path)
		}
		return nil
	})
	if skipped > 0 {
		log.Printf("[indexer] root %s - skipped %d generated or oversized (>%d KB) files", root.Path, skipped, MaxSourceFileBytes/1024)
	}
	return paths, err
}

// ReconcileRoot catches the graph up with the filesystem after Ambio was not
// running.
//
// The watcher only sees edits while archd is alive. Without this pass, closing
// Ambio, letting agents work overnight, and reopening would produce an empty
// Morning Delta - the single case the delta exists for. Reconciliation replays
// what the watcher would have seen, through the exact same ReindexFile and
// RemoveFile paths, so journaling, choreography, and broadcasts all behave
// identically to a live edit.
//
// After the file catch-up settles, it runs the same guarded live-classification
// pass the watcher schedules after a burst. ClusterLive only acts when new
// unclassified files have enough semantic evidence to form a useful group; its
// reconciliation preserves authored systems and existing Floor layouts.
func ReconcileRoot(sqlDB *sql.DB, h *hub.Hub, root db.Root, ignoredPaths []string) (changed int, err error) {
	return reconcileRoot(sqlDB, h, root, ignoredPaths, false)
}

// ReindexRootInPlace re-reads every in-scope file, whatever its timestamp,
// while keeping systems, placement, layout and history. It is the user's
// "re-index" when they suspect the map missed something: content that really
// changed is journaled like any edit, and an unchanged file changes nothing.
func ReindexRootInPlace(sqlDB *sql.DB, h *hub.Hub, root db.Root, ignoredPaths []string) (int, error) {
	// A file indexed before content hashes were recorded cannot say whether it
	// changed; re-reading it would otherwise report every such file as edited.
	// Those are refreshed quietly, and gain a hash for next time.
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return 0, err
	}
	var unknown []string
	for _, file := range files {
		if file.ContentHash == "" {
			unknown = append(unknown, file.RelPath)
		}
	}
	done := beginQuiet(root.ID, unknown)
	defer done()
	return reconcileRoot(sqlDB, h, root, ignoredPaths, true)
}

func reconcileRoot(sqlDB *sql.DB, h *hub.Hub, root db.Root, ignoredPaths []string, force bool) (changed int, err error) {
	paths, err := collectSourcePaths(root, ignoredPaths)
	if err != nil {
		return 0, err
	}
	existing, err := buildExistingMap(sqlDB, root.ID)
	if err != nil {
		return 0, err
	}

	seen := make(map[string]struct{}, len(paths))
	for _, absPath := range paths {
		relPath, relErr := filepath.Rel(root.Path, absPath)
		if relErr != nil {
			continue
		}
		relPath = filepath.ToSlash(relPath)
		seen[relPath] = struct{}{}

		prev, known := existing[relPath]
		if known && !force && !fileLooksModified(absPath, prev) {
			continue
		}
		// Re-read only because its timestamp was close: the same bytes are not
		// a change.
		if known && !force && prev.ContentHash != "" && contentHash(absPath) == prev.ContentHash {
			continue
		}
		if reindexErr := ReindexFile(sqlDB, h, root, absPath); reindexErr != nil {
			log.Printf("[reconcile] reindex %s: %v", relPath, reindexErr)
			continue
		}
		changed++
	}

	// Anything the database still knows about but the disk does not was
	// deleted while we were away.
	for relPath := range existing {
		if _, stillThere := seen[relPath]; stillThere {
			continue
		}
		absPath := filepath.Join(root.Path, filepath.FromSlash(relPath))
		if removeErr := RemoveFile(sqlDB, h, root, absPath); removeErr != nil {
			log.Printf("[reconcile] remove %s: %v", relPath, removeErr)
			continue
		}
		changed++
	}

	if changed > 0 {
		if classified, classifyErr := ClusterLive(sqlDB, root); classifyErr != nil {
			return changed, classifyErr
		} else if classified {
			log.Printf("[reconcile] root %s classified new files after catch-up", root.Path)
		}
		log.Printf("[reconcile] root %s caught up: %d files changed while Ambio was closed", root.Path, changed)
	}
	return changed, nil
}

// fileLooksModified is the cheap pre-filter: only files whose size or mtime
// moved are re-parsed. ReindexFile still hashes the content, so a touched but
// unchanged file costs one parse and produces no delta entry.
func fileLooksModified(absPath string, prev db.File) bool {
	info, err := os.Stat(absPath)
	if err != nil {
		return false
	}
	// Timestamps are coarse: a save in the same millisecond as the index, or
	// on a filesystem that keeps 1-2 second times (FAT, many network drives),
	// can carry a time at or before IndexedAt. Anything that close is
	// re-read; the content hash keeps an unchanged file out of the delta.
	return info.ModTime().UnixMilli() >= prev.IndexedAt-mtimeSlackMillis
}

const mtimeSlackMillis = 2000

func contentHash(absPath string) string {
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
