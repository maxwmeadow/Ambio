package indexer

import (
	"database/sql"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/parser"
)

// C# imports name namespaces, not files, and code in the same namespace needs
// no using at all - in most projects that is where nearly every reference
// lives. So a C# file links to the files declaring the types it mentions,
// looked up in every namespace it can see: its own and each enclosing one,
// the global namespace (Unity scripts), its usings and the project's global
// usings. A using whose types the file never mentions links nothing.

type csFile struct {
	id         string
	namespaces []string // declared; "" for the global namespace
	usings     []string
	globals    []string // `global using`: visible in every file
	types      []string // types declared here
	refs       map[string]bool
}

type csharpIndex struct {
	files   map[string]*csFile
	types   map[string][]string // "Namespace.Type" (or "Type") → declaring file IDs
	globals []string
}

var (
	csIdentifier  = regexp.MustCompile(`\b[A-Z][A-Za-z0-9_]*\b`)
	csLineComment = regexp.MustCompile(`//[^\n]*`)
	csString      = regexp.MustCompile(`@?"(?:[^"\\\n]|\\.)*"`)
)

func buildCSharpIndex(files []db.File) *csharpIndex {
	idx := &csharpIndex{files: map[string]*csFile{}, types: map[string][]string{}}
	for _, f := range files {
		if !strings.HasSuffix(strings.ToLower(f.RelPath), ".cs") {
			continue
		}
		cf := parseCSharpFile(f)
		if cf == nil {
			continue
		}
		idx.add(cf)
	}
	return idx
}

func parseCSharpFile(f db.File) *csFile {
	result, err := parser.ParseFile(f.Path, f.RelPath)
	if err != nil || result == nil {
		return nil
	}
	src, err := os.ReadFile(f.Path)
	if err != nil {
		return nil
	}
	cf := &csFile{id: f.ID, refs: csharpRefs(string(src))}
	for _, imp := range result.Imports {
		switch {
		case strings.HasPrefix(imp, "#ns:"):
			cf.namespaces = append(cf.namespaces, strings.TrimPrefix(imp, "#ns:"))
		case strings.HasPrefix(imp, "#global:"):
			cf.globals = append(cf.globals, strings.TrimPrefix(imp, "#global:"))
		default:
			cf.usings = append(cf.usings, imp)
		}
	}
	for _, s := range result.Symbols {
		if s.Kind == "class" || s.Kind == "interface" || s.Kind == "type" {
			cf.types = append(cf.types, s.Name)
		}
	}
	return cf
}

// csharpRefs is every capitalised identifier outside comments and strings:
// the types a file can mention.
func csharpRefs(src string) map[string]bool {
	src = csLineComment.ReplaceAllString(src, "")
	src = csString.ReplaceAllString(src, `""`)
	refs := map[string]bool{}
	for _, name := range csIdentifier.FindAllString(src, -1) {
		refs[name] = true
	}
	return refs
}

func (idx *csharpIndex) add(cf *csFile) {
	idx.files[cf.id] = cf
	idx.globals = append(idx.globals, cf.globals...)
	namespaces := cf.namespaces
	if len(namespaces) == 0 {
		namespaces = []string{""}
	}
	for _, ns := range namespaces {
		for _, t := range cf.types {
			key := qualify(ns, t)
			idx.types[key] = append(idx.types[key], cf.id)
		}
	}
}

func qualify(ns, name string) string {
	if ns == "" {
		return name
	}
	return ns + "." + name
}

// links is every file a C# file depends on, sorted, without itself.
func (idx *csharpIndex) links(id string) []string {
	cf := idx.files[id]
	if cf == nil {
		return nil
	}
	visible := map[string]bool{"": true}
	for _, ns := range cf.namespaces {
		// Namespace A.B.C sees A.B.C, A.B and A without a using.
		for parts := strings.Split(ns, "."); len(parts) > 0; parts = parts[:len(parts)-1] {
			visible[strings.Join(parts, ".")] = true
		}
	}
	for _, ns := range cf.usings {
		visible[ns] = true
	}
	for _, ns := range idx.globals {
		visible[ns] = true
	}
	seen := map[string]bool{id: true}
	var out []string
	for name := range cf.refs {
		for ns := range visible {
			for _, dst := range idx.types[qualify(ns, name)] {
				if !seen[dst] {
					seen[dst] = true
					out = append(out, dst)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

// buildCSharpDependenciesForFile replaces a C# file's IMPORTS dependencies
// with the files declaring the types it uses.
func buildCSharpDependenciesForFile(sqlDB *sql.DB, root db.Root, f db.File, idx *csharpIndex) error {
	if err := db.DeleteOutgoingDependenciesByFile(sqlDB, f.ID); err != nil {
		return err
	}
	for _, dstID := range idx.links(f.ID) {
		d := db.Dependency{
			WorkspaceID:    root.WorkspaceID,
			Src:            f.ID,
			Dst:            dstID,
			SrcType:        "file",
			DstType:        "file",
			DependencyType: "IMPORTS",
			CreatedBy:      "parser",
		}
		if err := db.UpsertDependency(sqlDB, d); err != nil {
			log.Printf("indexer: upsert cs dependency %s→%s: %v", f.RelPath, dstID, err)
		}
	}
	return nil
}
