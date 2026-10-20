package indexer

import (
	"path/filepath"
	"strings"

	"ambio.local/archd/internal/db"
)

// InScope reports whether a path relative to root is one the indexer would
// read: a supported source file outside skipped, hidden and excluded folders.
// It applies collectSourcePaths' rules to a single path, for callers that
// learn about files from Git rather than by walking the tree (another
// checkout's changes, docs/GIT_AND_PROJECT_SHAPES.md "One map, many
// checkouts").
func InScope(root db.Root, relPath string) bool {
	relPath = filepath.ToSlash(filepath.Clean(relPath))
	if relPath == "." || strings.HasPrefix(relPath, "../") || !IsSupportedSourceFile(relPath) {
		return false
	}
	segments := strings.Split(relPath, "/")
	for _, segment := range segments[:len(segments)-1] {
		if skipDirs[segment] || strings.HasPrefix(segment, ".") {
			return false
		}
	}
	return !ignoredBelow(root, relPath)
}

// SkipFolder reports whether the indexer leaves a folder unread: a skipped
// or hidden name, or one of the root's exclusions.
func SkipFolder(root db.Root, relDir, name string) bool {
	return skipDirs[name] || strings.HasPrefix(name, ".") || ignoredBelow(root, relDir)
}

func ignoredBelow(root db.Root, relPath string) bool {
	absPath := strings.ToLower(filepath.Join(root.Path, filepath.FromSlash(relPath)))
	for _, ignored := range root.IgnoredPaths {
		native := filepath.FromSlash(ignored)
		native = strings.TrimSuffix(native, string(filepath.Separator)+"**")
		native = strings.TrimSuffix(native, "/**")
		dir := strings.ToLower(filepath.Clean(native))
		if dir != "" && dir != "." && (absPath == dir || strings.HasPrefix(absPath, dir+string(filepath.Separator))) {
			return true
		}
	}
	return false
}
