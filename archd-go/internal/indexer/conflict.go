package indexer

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"

	"ambio.local/archd/internal/gitworktree"
)

// awaitingResolution reports whether a file holds Git's conflict markers for
// a merge, rebase, cherry-pick or stash pop still being resolved. That text is
// nobody's code: parsed, the file lost its imports and calls, and Review
// Changes listed the conflict as you deleting them. Such a file keeps its last
// map until it is resolved; aborting puts back what the map already shows.
func awaitingResolution(absPath string) bool {
	raw, err := os.ReadFile(absPath)
	if err != nil || !hasConflictMarkers(raw) {
		return false
	}
	// Markers alone could be a fixture's text; Git knowing the file as
	// unmerged is what makes it a conflict.
	out, err := gitworktree.Command(filepath.Dir(absPath), "ls-files", "-u", "--", filepath.Base(absPath)).Output()
	return err == nil && len(bytes.TrimSpace(out)) > 0
}

// hasConflictMarkers finds "<<<<<<<", "=======" and ">>>>>>>" opening lines
// in that order.
func hasConflictMarkers(raw []byte) bool {
	markers := [][]byte{[]byte("<<<<<<<"), []byte("======="), []byte(">>>>>>>")}
	next := 0
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 64*1024), len(raw)+1)
	for scanner.Scan() {
		if bytes.HasPrefix(scanner.Bytes(), markers[next]) {
			next++
			if next == len(markers) {
				return true
			}
		}
	}
	return false
}
