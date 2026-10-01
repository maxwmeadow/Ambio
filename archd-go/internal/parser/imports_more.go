package parser

import (
	"path"
	"regexp"
	"strings"
)

// Import specs for Java, Rust, Ruby and C++. Like C#, these are read from the
// source text: the statements are line-shaped and the grammars disagree on
// their trees. Each spec carries a prefix telling the indexer how to resolve
// it to project files (indexer.resolveImportFileIDs); anything that names an
// external package or the standard library resolves to nothing and is dropped
// there.
//
//	java:class:<a/b/C>     a class, matched by path tail (src/main/java/a/b/C.java)
//	java:pkg:<a/b>         every file of a package (import a.b.*)
//	rust:path:<dir/a/b/C>  a module path; the longest prefix that is a file wins
//	ruby:path:<dir/x>      require_relative, already resolved against the file
//	ruby:req:<x/y>         require, tried under lib/, the root and by path tail
//	cpp:inc:<dir>|<spec>   #include "spec" from dir; headers resolve to their
//	                       implementation file, since headers are not indexed
const (
	ImportJavaClass = "java:class:"
	ImportJavaPkg   = "java:pkg:"
	ImportRustPath  = "rust:path:"
	ImportRubyPath  = "ruby:path:"
	ImportRubyReq   = "ruby:req:"
	ImportCppInc    = "cpp:inc:"
)

var (
	javaImportRe   = regexp.MustCompile(`(?m)^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;`)
	rustModRe      = regexp.MustCompile(`(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;`)
	rustUseRe      = regexp.MustCompile(`(?ms)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);`)
	rubyRequireRe  = regexp.MustCompile(`(?m)^\s*(require_relative|require)\s*\(?\s*['"]([^'"]+)['"]`)
	cppIncludeRe   = regexp.MustCompile(`(?m)^\s*#\s*include\s*"([^"]+)"`)
	rustAliasRe    = regexp.MustCompile(`\s+as\s+\w+`)
	blockCommentRe = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

func extractTextImports(src []byte, lang, relPath string) []string {
	text := string(src)
	if lang != "ruby" {
		text = blockCommentRe.ReplaceAllString(text, "")
	}
	var specs []string
	seen := map[string]bool{}
	add := func(spec string) {
		if spec != "" && !seen[spec] {
			seen[spec] = true
			specs = append(specs, spec)
		}
	}
	dir := path.Dir(relPath)
	switch lang {
	case "java":
		for _, match := range javaImportRe.FindAllStringSubmatch(text, -1) {
			name := match[2]
			if strings.HasSuffix(name, ".*") {
				add(ImportJavaPkg + strings.ReplaceAll(strings.TrimSuffix(name, ".*"), ".", "/"))
				continue
			}
			parts := strings.Split(name, ".")
			if match[1] != "" && len(parts) > 1 {
				parts = parts[:len(parts)-1] // import static a.B.member → a.B
			}
			add(ImportJavaClass + strings.Join(parts, "/"))
		}
	case "rust":
		module := rustModuleDir(relPath)
		for _, match := range rustModRe.FindAllStringSubmatch(text, -1) {
			add(ImportRustPath + path.Join(module, match[1]))
		}
		crate := rustCrateRoot(relPath)
		for _, match := range rustUseRe.FindAllStringSubmatch(text, -1) {
			tree := strings.Join(strings.Fields(rustAliasRe.ReplaceAllString(match[1], "")), "")
			for _, use := range expandRustUse(tree) {
				if resolved, ok := rustUsePath(use, crate, module); ok {
					add(ImportRustPath + resolved)
				}
			}
		}
	case "ruby":
		for _, match := range rubyRequireRe.FindAllStringSubmatch(text, -1) {
			spec := strings.TrimSuffix(match[2], ".rb")
			if match[1] == "require_relative" {
				add(ImportRubyPath + path.Clean(path.Join(dir, spec)))
			} else {
				add(ImportRubyReq + path.Clean(spec))
			}
		}
	case "cpp":
		for _, match := range cppIncludeRe.FindAllStringSubmatch(text, -1) {
			add(ImportCppInc + dir + "|" + path.Clean(match[1]))
		}
	}
	return specs
}

// rustModuleDir is where a file's child modules live: beside mod.rs, lib.rs
// and main.rs, otherwise in a folder named after the file (foo.rs → foo/).
func rustModuleDir(relPath string) string {
	dir := path.Dir(relPath)
	switch path.Base(relPath) {
	case "mod.rs", "lib.rs", "main.rs":
		return dir
	}
	return path.Join(dir, strings.TrimSuffix(path.Base(relPath), ".rs"))
}

// rustCrateRoot is the crate's src folder: the nearest ancestor named src, or
// the file's own folder when there is none.
func rustCrateRoot(relPath string) string {
	for dir := path.Dir(relPath); dir != "." && dir != "/"; dir = path.Dir(dir) {
		if path.Base(dir) == "src" {
			return dir
		}
	}
	return path.Dir(relPath)
}

// expandRustUse flattens a use tree: a::{b, c::{d, e}} → a::b, a::c::d, a::c::e.
// Globs and trailing self are dropped from the path; aliases are removed
// before this is called.
func expandRustUse(tree string) []string {
	open := strings.Index(tree, "{")
	if open < 0 {
		return []string{strings.TrimSuffix(strings.TrimSuffix(tree, "::*"), "::self")}
	}
	prefix := tree[:open]
	inner := tree[open+1:]
	if i := strings.LastIndex(inner, "}"); i >= 0 {
		inner = inner[:i]
	}
	var out []string
	depth, start := 0, 0
	for i := 0; i <= len(inner); i++ {
		if i < len(inner) {
			switch inner[i] {
			case '{':
				depth++
				continue
			case '}':
				depth--
				continue
			case ',':
				if depth > 0 {
					continue
				}
			default:
				continue
			}
		}
		part := inner[start:i]
		start = i + 1
		if part == "" {
			continue
		}
		if part == "self" {
			out = append(out, strings.TrimSuffix(prefix, "::"))
			continue
		}
		out = append(out, expandRustUse(prefix+part)...)
	}
	return out
}

// rustUsePath turns crate::a::b, self::a and super::a into a folder path.
// Paths into other crates (std::, serde::) are not project files.
func rustUsePath(use, crate, module string) (string, bool) {
	segments := strings.Split(use, "::")
	if len(segments) < 2 {
		return "", false
	}
	var base string
	switch segments[0] {
	case "crate":
		base = crate
	case "self":
		base = module
	case "super":
		base = path.Dir(module)
		for len(segments) > 2 && segments[1] == "super" {
			base = path.Dir(base)
			segments = segments[1:]
		}
	default:
		return "", false
	}
	return path.Join(append([]string{base}, segments[1:]...)...), true
}
