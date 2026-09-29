package indexer

import (
	"database/sql"
	"log"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/parser"
)

// DetectionEvidenceVersion is bumped whenever the parser learns to extract new
// detection evidence, so existing indexes are refreshed once.
//
// 1: external packages and env reads per file, and require()/import() of
// project files in the import graph.
// 2: Python imports from a monorepo folder's source root and each name in
// "from pkg import mod"; Go imports to every file of the imported package.
// 3: full Python module names; packages and env reads in Java, C#, Ruby, Rust.
const DetectionEvidenceVersion = 3

// EnsureDetectionEvidence brings a root's detection evidence up to date. An
// index built by an older archd has none; a full parse pass fills it in and
// rebuilds imports so lazily loaded adapters are part of the graph.
func EnsureDetectionEvidence(sqlDB *sql.DB, root db.Root) error {
	if db.DetectionEvidenceVersion(sqlDB, root.ID) >= DetectionEvidenceVersion {
		return nil
	}
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	relToID := buildImportPathIndex(files)
	for _, f := range files {
		result, err := parser.ParseFile(f.Path, f.RelPath)
		if err != nil {
			continue // a file gone since the index; the watcher removes it
		}
		if err := db.ReplaceFileEvidence(sqlDB, f.ID, packageUses(result), envReads(result)); err != nil {
			return err
		}
		if err := rebuildDependenciesForFileWithIndex(sqlDB, root, f, relToID); err != nil {
			log.Printf("indexer: evidence backfill imports for %s: %v", f.RelPath, err)
		}
	}
	log.Printf("[indexer] detection evidence backfilled for %d files in %s", len(files), root.Path)
	return db.SetDetectionEvidenceVersion(sqlDB, root.ID, DetectionEvidenceVersion)
}

func packageUses(result *parser.Result) []db.PackageUse {
	out := make([]db.PackageUse, 0, len(result.Packages))
	for _, ref := range result.Packages {
		out = append(out, db.PackageUse{Package: ref.Package, Line: ref.Line})
	}
	return out
}

func envReads(result *parser.Result) []db.EnvRead {
	out := make([]db.EnvRead, 0, len(result.EnvReads))
	for _, ref := range result.EnvReads {
		out = append(out, db.EnvRead{Name: ref.Name, Line: ref.Line})
	}
	return out
}
