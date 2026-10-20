package gitworktree

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// FindRepositories lists the Git repositories inside root - separate
// repositories under a parent folder, and submodules - as folders relative to
// root, nearest first. root's own repository is not listed. A repository's
// folder is not searched further, skip prunes folders the indexer does not
// read, and maxDepth bounds the walk so a huge tree costs little.
func FindRepositories(root string, maxDepth int, skip func(relDir, name string) bool) []string {
	var found []string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return filepath.SkipDir
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if skip(rel, entry.Name()) || strings.Count(rel, "/") >= maxDepth {
			return filepath.SkipDir
		}
		if _, statErr := os.Stat(filepath.Join(path, ".git")); statErr == nil {
			found = append(found, rel)
			return filepath.SkipDir
		}
		return nil
	})
	return found
}
