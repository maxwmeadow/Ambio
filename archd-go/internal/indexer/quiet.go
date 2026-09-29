package indexer

import (
	"database/sql"
	"path/filepath"
	"sync"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
)

// Changing which folders Axiom reads is not a change to the code. A re-scope
// still has to add newly included files to the map and drop newly excluded
// ones, but none of that belongs in the Morning Delta: "you excluded vendor/"
// must never read as "an agent deleted 300 files".
//
// While a re-scope runs, the files moving in or out of scope are "quiet":
// their own events, and any relationship touching them, are not journaled.
// Concurrent edits to every other file are journaled as usual. System births
// and deaths for the root are also held back, because re-clustering after a
// scope change reshapes systems for the same non-reason.

type quietScope struct {
	paths map[string]struct{}
	depth int
}

var (
	quietMu    sync.Mutex
	quietRoots = map[string]*quietScope{}
)

func beginQuiet(rootID string, relPaths []string) func() {
	quietMu.Lock()
	scope := quietRoots[rootID]
	if scope == nil {
		scope = &quietScope{paths: map[string]struct{}{}}
		quietRoots[rootID] = scope
	}
	scope.depth++
	for _, path := range relPaths {
		scope.paths[path] = struct{}{}
	}
	quietMu.Unlock()
	return func() {
		quietMu.Lock()
		defer quietMu.Unlock()
		scope.depth--
		if scope.depth == 0 {
			delete(quietRoots, rootID)
		}
	}
}

func isQuietPath(rootID, relPath string) bool {
	quietMu.Lock()
	defer quietMu.Unlock()
	scope := quietRoots[rootID]
	if scope == nil {
		return false
	}
	_, quiet := scope.paths[relPath]
	return quiet
}

func isQuietRoot(rootID string) bool {
	quietMu.Lock()
	defer quietMu.Unlock()
	return quietRoots[rootID] != nil
}

// ReconcileScope brings a root in line with new exclusions without recording
// the scope change itself as drift. Files whose content changed while they
// stayed in scope are still journaled.
func ReconcileScope(sqlDB *sql.DB, h *hub.Hub, root db.Root, previousIgnored, ignored []string) (int, error) {
	before, err := collectSourcePaths(root, previousIgnored)
	if err != nil {
		return 0, err
	}
	after, err := collectSourcePaths(root, ignored)
	if err != nil {
		return 0, err
	}
	moved := scopeDifference(root.Path, before, after)
	done := beginQuiet(root.ID, moved)
	defer done()
	return ReconcileRoot(sqlDB, h, root, ignored)
}

// scopeDifference returns the relative paths present in exactly one of the
// two absolute path lists.
func scopeDifference(rootPath string, before, after []string) []string {
	rel := func(paths []string) map[string]struct{} {
		out := make(map[string]struct{}, len(paths))
		for _, path := range paths {
			if relPath, err := filepath.Rel(rootPath, path); err == nil {
				out[filepath.ToSlash(relPath)] = struct{}{}
			}
		}
		return out
	}
	was, now := rel(before), rel(after)
	var moved []string
	for path := range was {
		if _, still := now[path]; !still {
			moved = append(moved, path)
		}
	}
	for path := range now {
		if _, already := was[path]; !already {
			moved = append(moved, path)
		}
	}
	return moved
}
