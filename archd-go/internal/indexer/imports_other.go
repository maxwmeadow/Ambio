package indexer

import (
	"path"
	"strings"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/parser"
)

// Resolution for the text-read import specs (parser/imports_text.go): C/C++
// includes, Java/Kotlin imports, Rust modules, Ruby requires, PHP includes and
// namespaces, Swift modules. Each names project files by a different rule, and
// most name a file by the end of its path, so the index keeps every file's
// path suffixes ("sfx:") and every folder's ("dir:" for its files).
//
// A spec that matches nothing is a dependency outside the project, as with
// bare JavaScript module names.

const (
	suffixPrefix  = "sfx:"
	dirPrefix     = "dir:"
	dirBasePrefix = "dirname:"
	maxPerKey     = 40
)

// indexSuffixes records, for one file, every path suffix at a folder
// boundary (lower-cased), its folder, and its folder's name.
func indexSuffixes(index map[string]string, relPath, id string) {
	appendID := func(key string) {
		existing := index[key]
		if existing == "" {
			index[key] = id
			return
		}
		if strings.Count(existing, ",") >= maxPerKey-1 {
			return
		}
		index[key] = existing + "," + id
	}
	lower := strings.ToLower(relPath)
	parts := strings.Split(lower, "/")
	for i := range parts {
		appendID(suffixPrefix + strings.Join(parts[i:], "/"))
	}
	dir := path.Dir(lower)
	appendID(dirPrefix + dir)
	if dir != "." {
		// Every suffix of the folder, for package-style lookups (com/acme/util).
		dirParts := strings.Split(dir, "/")
		for i := range dirParts {
			appendID(dirPrefix + "~" + strings.Join(dirParts[i:], "/"))
		}
		appendID(dirBasePrefix + path.Base(dir))
	}
}

func idsFor(index map[string]string, key string) []string {
	if joined, ok := index[key]; ok && joined != "" {
		return strings.Split(joined, ",")
	}
	return nil
}

// closest picks, among files ending in the same suffix, the one sharing the
// longest folder prefix with the importing file.
func closest(ids []string, from string, relOf func(string) string) []string {
	if len(ids) <= 1 {
		return ids
	}
	best, bestScore := "", -1
	fromParts := strings.Split(path.Dir(from), "/")
	for _, id := range ids {
		parts := strings.Split(path.Dir(strings.ToLower(relOf(id))), "/")
		score := 0
		for score < len(parts) && score < len(fromParts) && parts[score] == fromParts[score] {
			score++
		}
		if score > bestScore {
			best, bestScore = id, score
		}
	}
	return []string{best}
}

// resolveTextSpec resolves one tagged spec; ok is false when the spec is not
// one of these kinds (the caller falls back to the JS/Python/Go rules).
func resolveTextSpec(file db.File, spec string, index map[string]string, relOf func(string) string) (ids []string, ok bool) {
	from := strings.ToLower(path.Clean(strings.ReplaceAll(file.RelPath, `\`, "/")))
	dir := path.Dir(from)
	exact := func(rel string) []string {
		return idsFor(index, suffixPrefix+strings.ToLower(path.Clean(rel)))
	}
	// A path relative to the importing file: only an exact match counts.
	relative := func(rel string) []string {
		target := path.Clean(path.Join(dir, strings.ToLower(rel)))
		for _, id := range idsFor(index, suffixPrefix+target) {
			if strings.ToLower(relOf(id)) == target {
				return []string{id}
			}
		}
		return nil
	}
	switch {
	case strings.HasPrefix(spec, parser.SpecIncludeLocal):
		inc := spec[len(parser.SpecIncludeLocal):]
		if hit := relative(inc); hit != nil {
			return hit, true
		}
		return closest(exact(inc), from, relOf), true
	case strings.HasPrefix(spec, parser.SpecIncludeSystem):
		// <mylib/foo.h> is a project header only if its path is distinctive:
		// <stdio.h> must not land on some vendored stdio.h.
		inc := spec[len(parser.SpecIncludeSystem):]
		if !strings.Contains(inc, "/") {
			return nil, true
		}
		return closest(exact(inc), from, relOf), true

	case strings.HasPrefix(spec, parser.SpecJVM):
		name := spec[len(parser.SpecJVM):]
		if strings.HasSuffix(name, ".*") {
			pkg := strings.ReplaceAll(strings.TrimSuffix(name, ".*"), ".", "/")
			return filterExt(idsFor(index, dirPrefix+"~"+strings.ToLower(pkg)), relOf, ".java", ".kt", ".kts"), true
		}
		// a.b.C, or a.b.C.member for a static import: the longest prefix that
		// names a class file.
		segments := strings.Split(name, ".")
		for n := len(segments); n >= 2; n-- {
			base := strings.Join(segments[:n], "/")
			for _, ext := range []string{".java", ".kt"} {
				if hit := exact(base + ext); hit != nil {
					return closest(hit, from, relOf), true
				}
			}
		}
		return nil, true

	case strings.HasPrefix(spec, parser.SpecRustMod):
		name := strings.ToLower(spec[len(parser.SpecRustMod):])
		moduleDir := dir
		// foo.rs declares its children in foo/; mod.rs, lib.rs and main.rs in
		// their own folder.
		if base := path.Base(from); base != "mod.rs" && base != "lib.rs" && base != "main.rs" {
			moduleDir = path.Join(dir, strings.TrimSuffix(base, ".rs"))
		}
		for _, candidate := range []string{path.Join(moduleDir, name+".rs"), path.Join(moduleDir, name, "mod.rs")} {
			if hit := exactRel(index, relOf, candidate); hit != nil {
				return hit, true
			}
		}
		return nil, true
	case strings.HasPrefix(spec, parser.SpecRustUse):
		return resolveRustUse(from, spec[len(parser.SpecRustUse):], index, relOf), true

	case strings.HasPrefix(spec, parser.SpecRubyRelative):
		rel := spec[len(parser.SpecRubyRelative):]
		if !strings.HasSuffix(rel, ".rb") {
			rel += ".rb"
		}
		return relative(rel), true
	case strings.HasPrefix(spec, parser.SpecRuby):
		rel := spec[len(parser.SpecRuby):]
		if !strings.HasSuffix(rel, ".rb") {
			rel += ".rb"
		}
		// `require "json"` is a gem; a project file is required by a path the
		// project's own load path (lib/, app/) makes unique.
		hits := exact(rel)
		if len(hits) == 1 && (strings.Contains(rel, "/") || strings.HasPrefix(strings.ToLower(relOf(hits[0])), "lib/")) {
			return hits, true
		}
		return nil, true

	case strings.HasPrefix(spec, parser.SpecPHPFile):
		rel := spec[len(parser.SpecPHPFile):]
		// __DIR__ . '/x.php' arrives as "/x.php": relative to the file.
		return relative(strings.TrimPrefix(rel, "/")), true
	case strings.HasPrefix(spec, parser.SpecPHPNamespace):
		// PSR-4: App\Models\User lives at <root for App>/Models/User.php. The
		// root folder is not named after the namespace (App\ -> app/ or src/),
		// so match the longest suffix that names exactly one file.
		segments := strings.Split(spec[len(parser.SpecPHPNamespace):], `\`)
		for n := len(segments); n >= 2; n-- {
			hits := exact(strings.Join(segments[len(segments)-n:], "/") + ".php")
			if len(hits) == 1 {
				return hits, true
			}
			if len(hits) > 1 {
				return closest(hits, from, relOf), true
			}
		}
		return nil, true

	case strings.HasPrefix(spec, parser.SpecSwift):
		// A Swift module is a target folder (Sources/Name). Foundation and
		// other system modules match no folder.
		module := strings.ToLower(spec[len(parser.SpecSwift):])
		return filterExt(idsFor(index, dirBasePrefix+module), relOf, ".swift"), true
	}
	return nil, false
}

func exactRel(index map[string]string, relOf func(string) string, rel string) []string {
	rel = strings.ToLower(path.Clean(rel))
	for _, id := range idsFor(index, suffixPrefix+rel) {
		if strings.ToLower(relOf(id)) == rel {
			return []string{id}
		}
	}
	return nil
}

func filterExt(ids []string, relOf func(string) string, exts ...string) []string {
	var out []string
	for _, id := range ids {
		lower := strings.ToLower(relOf(id))
		for _, ext := range exts {
			if strings.HasSuffix(lower, ext) {
				out = append(out, id)
				break
			}
		}
	}
	return out
}

// resolveRustUse maps crate::a::b::Item (or self:: / super::) to the module
// file that defines it: the longest path prefix naming a.rs, a/b.rs or
// a/b/mod.rs from the crate root (the folder holding lib.rs or main.rs).
func resolveRustUse(from, usePath string, index map[string]string, relOf func(string) string) []string {
	segments := strings.Split(strings.ToLower(usePath), "::")
	if len(segments) < 2 {
		return nil
	}
	var base string
	switch segments[0] {
	case "crate":
		base = rustCrateRoot(from, index, relOf)
		if base == "" {
			return nil
		}
	case "self", "super":
		base = path.Dir(from)
		if name := path.Base(from); name != "mod.rs" && name != "lib.rs" && name != "main.rs" {
			base = path.Join(base, strings.TrimSuffix(name, ".rs"))
		}
		for _, s := range segments {
			if s != "super" {
				break
			}
			base = path.Dir(base)
		}
	default:
		return nil
	}
	rest := segments[1:]
	for len(rest) > 0 && rest[0] == "super" {
		rest = rest[1:]
	}
	for n := len(rest); n >= 1; n-- {
		mod := path.Join(append([]string{base}, rest[:n]...)...)
		for _, candidate := range []string{mod + ".rs", path.Join(mod, "mod.rs")} {
			if hit := exactRel(index, relOf, candidate); hit != nil {
				return hit
			}
		}
	}
	// The item lives in the module itself: super::Invoice is defined in the
	// parent's own file, crate::run in lib.rs or main.rs.
	candidates := []string{base + ".rs", path.Join(base, "mod.rs")}
	if segments[0] == "crate" {
		candidates = []string{path.Join(base, "lib.rs"), path.Join(base, "main.rs")}
	}
	for _, candidate := range candidates {
		if hit := exactRel(index, relOf, candidate); hit != nil && relOf(hit[0]) != "" && strings.ToLower(relOf(hit[0])) != from {
			return hit
		}
	}
	return nil
}

// rustCrateRoot is the nearest folder above a file holding lib.rs or main.rs.
func rustCrateRoot(from string, index map[string]string, relOf func(string) string) string {
	for dir := path.Dir(from); ; dir = path.Dir(dir) {
		for _, root := range []string{"lib.rs", "main.rs"} {
			if exactRel(index, relOf, path.Join(dir, root)) != nil {
				return dir
			}
		}
		if dir == "." || dir == "/" || dir == "" {
			return ""
		}
	}
}
