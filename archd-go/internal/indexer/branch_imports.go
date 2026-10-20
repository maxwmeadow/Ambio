package indexer

import (
	"sort"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/parser"
)

// ResolveImports parses the file at absPath as file.RelPath and resolves its
// imports against files, without touching the database: the same path rules
// the indexer uses for JS/TS, Python, Go and the other path-based languages
// (C# namespace imports are not resolved here). It is how a branch that is
// not on the Floor is compared with its base, one changed file at a time
// (api/branch_review.go).
func ResolveImports(absPath string, file db.File, files []db.File) ([]string, error) {
	result, err := parser.ParseFile(absPath, file.RelPath)
	if err != nil {
		return nil, err
	}
	index := buildImportPathIndex(files)
	seen := map[string]struct{}{}
	for _, imported := range result.Imports {
		for _, id := range resolveImportFileIDs(file, imported, index) {
			if id != "" && id != file.ID {
				seen[id] = struct{}{}
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}
