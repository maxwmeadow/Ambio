package infradetect

import (
	"bytes"
	"database/sql"
	"os"
	"path/filepath"
	"strings"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/registry"
)

// Load gathers detection inputs for one root from the index and the disk.
func Load(sqlDB *sql.DB, root db.Root, reg *registry.Registry) (Inputs, error) {
	in := Inputs{Config: map[string][]byte{}, Registry: reg}
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return in, err
	}
	byID := map[string]db.File{}
	for _, f := range files {
		byID[f.ID] = f
		in.Files = append(in.Files, File{ID: f.ID, RelPath: f.RelPath, Language: f.Language})
	}
	deps, err := db.GetDependenciesByRoot(sqlDB, root.ID)
	if err != nil {
		return in, err
	}
	for _, d := range deps {
		if d.SrcType == "file" && d.DstType == "file" && d.DependencyType == "IMPORTS" {
			in.Imports = append(in.Imports, Import{From: d.Src, To: d.Dst})
		}
	}
	uses, err := db.GetPackageUses(sqlDB, root.ID)
	if err != nil {
		return in, err
	}
	for _, u := range uses {
		in.Packages = append(in.Packages, PackageUse{FileID: u.FileID, Package: u.Package, Line: u.Line})
	}
	reads, err := db.GetEnvReads(sqlDB, root.ID)
	if err != nil {
		return in, err
	}
	for _, r := range reads {
		in.EnvReads = append(in.EnvReads, EnvRead{FileID: r.FileID, Name: r.Name, Line: r.Line})
	}
	if workflows, err := filepath.Glob(filepath.Join(root.Path, ".github", "workflows", "*.y*ml")); err == nil {
		for _, abs := range workflows {
			if body, err := os.ReadFile(abs); err == nil {
				in.Config[".github/workflows/"+filepath.Base(abs)] = body
			}
		}
	}
	pathOf := map[string]string{}
	for _, f := range files {
		pathOf[f.RelPath] = f.Path
	}
	in.ReadSource = func(relPath string) []byte {
		abs, ok := pathOf[relPath]
		if !ok {
			return nil
		}
		if info, err := os.Stat(abs); err != nil || info.Size() > 512*1024 {
			return nil
		}
		body, err := os.ReadFile(abs)
		if err != nil {
			return nil
		}
		return body
	}
	walkConfig(root.Path, in.Config)
	// A platform cron names a route; finding the handler means reading
	// sources. Only done when there are crons to trace, and only small files.
	if vercel, ok := in.Config["vercel.json"]; ok && bytes.Contains(vercel, []byte(`"crons"`)) {
		in.Sources = map[string][]byte{}
		for _, f := range files {
			if info, err := os.Stat(f.Path); err == nil && info.Size() <= 256*1024 {
				if body, err := os.ReadFile(f.Path); err == nil {
					in.Sources[f.RelPath] = body
				}
			}
		}
	}
	// Scheduler adapters are read in full: their cron expressions are the
	// role's contract.
	for _, u := range in.Packages {
		f := byID[u.FileID]
		for _, s := range reg.All() {
			if s.Category != "scheduler" || s.Detect == nil {
				continue
			}
			for _, pkg := range s.Detect.Packages[languageFamily(f.Language)] {
				if pkg == u.Package {
					if body, err := os.ReadFile(f.Path); err == nil {
						in.Config[f.RelPath] = body
					}
				}
			}
		}
	}
	return in, nil
}

// walkConfig reads the project files detection understands, wherever they
// sit: a monorepo keeps its package.json, Dockerfile and fly.toml in each
// service's folder, not at the root. SQL files and ORM schemas (a database's
// contract) are read too; they are not indexed as source.
func walkConfig(rootPath string, config map[string][]byte) {
	skip := map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, "out": true,
		"vendor": true, "target": true, ".next": true, "venv": true, ".venv": true, "__pycache__": true}
	count := 0
	_ = filepath.WalkDir(rootPath, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, relErr := filepath.Rel(rootPath, path)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			if path == rootPath {
				return nil
			}
			if skip[entry.Name()] || strings.HasPrefix(entry.Name(), ".") || strings.Count(rel, "/") >= 5 {
				return filepath.SkipDir
			}
			return nil
		}
		if !WantsConfig(rel) {
			return nil
		}
		if count >= 800 {
			return filepath.SkipAll
		}
		if info, err := entry.Info(); err != nil || info.Size() > 1024*1024 {
			return nil
		}
		if body, err := os.ReadFile(path); err == nil {
			config[rel] = body
			count++
		}
		return nil
	})
}
