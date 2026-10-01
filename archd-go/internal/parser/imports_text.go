package parser

import (
	"regexp"
	"strings"
)

// Import specs for the languages whose imports are read as text. Each spec is
// tagged with how it names a file, and the indexer resolves it
// (indexer.resolveImportFileIDs):
//
//	inc"path     C/C++ #include "path" - relative to the file, then the project
//	inc<path     C/C++ #include <path> - project headers on an include path
//	jvm:a.b.C    Java/Kotlin import of a class (a.b.* for a package)
//	rs-mod:name  Rust `mod name;` - a child module file
//	rs-use:path  Rust `use crate::a::b` / `self::` / `super::`
//	rb-rel:path  Ruby require_relative
//	rb:path      Ruby require of a project file (gems resolve to nothing)
//	php-file:p   PHP require/include of a path (relative to the file)
//	php-ns:A\B   PHP `use` of a namespaced class (PSR-4 layout)
//	swift:Mod    Swift `import Mod` - a module folder in the project
//	lua:a.b      Lua `require "a.b"` - a/b.lua or a/b/init.lua
//	sh:path      shell `source path` / `. path`
//	ex:A.B       Elixir alias/import/use/require of a module (lib/a/b.ex)
//
// Scala and Groovy imports name JVM classes and use jvm: too.
const (
	SpecIncludeLocal  = `inc"`
	SpecIncludeSystem = "inc<"
	SpecJVM           = "jvm:"
	SpecRustMod       = "rs-mod:"
	SpecRustUse       = "rs-use:"
	SpecRubyRelative  = "rb-rel:"
	SpecRuby          = "rb:"
	SpecPHPFile       = "php-file:"
	SpecPHPNamespace  = "php-ns:"
	SpecSwift         = "swift:"
	SpecLua           = "lua:"
	SpecShell         = "sh:"
	SpecElixir        = "ex:"
)

var (
	cInclude      = regexp.MustCompile(`(?m)^\s*#\s*include\s*([<"])([^>"\n]+)[>"]`)
	javaImport    = regexp.MustCompile(`(?m)^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*?)(\.\*)?\s*;`)
	kotlinImport  = regexp.MustCompile(`(?m)^\s*import\s+([A-Za-z_][\w.]*?)(\.\*)?(?:\s+as\s+\w+)?\s*$`)
	rustMod       = regexp.MustCompile(`(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;`)
	rustUse       = regexp.MustCompile(`(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);`)
	rubyRelative  = regexp.MustCompile(`(?m)^\s*require_relative\s*\(?\s*['"]([^'"\n]+)['"]`)
	rubyRequire   = regexp.MustCompile(`(?m)^\s*(?:require|load)\s*\(?\s*['"]([^'"\n]+)['"]`)
	phpInclude    = regexp.MustCompile(`(?m)\b(?:require|include)(?:_once)?\s*\(?\s*(__DIR__\s*\.\s*)?['"]([^'"\n]+\.php)['"]`)
	phpUse        = regexp.MustCompile(`(?m)^\s*use\s+(?:function\s+|const\s+)?\\?([A-Za-z_][\w\\]*)(?:\s+as\s+\w+)?\s*;`)
	phpGroupedUse = regexp.MustCompile(`(?m)^\s*use\s+\\?([A-Za-z_][\w\\]*)\\\{([^}]*)\}\s*;`)
	rustAlias     = regexp.MustCompile(`\s+as\s+\w+`)
	scalaImport   = regexp.MustCompile(`(?m)^\s*import\s+([^\n;]+)`)
	groovyImport  = regexp.MustCompile(`(?m)^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$`)
	luaRequire    = regexp.MustCompile(`\brequire\s*\(?\s*['"]([^'"\n]+)['"]`)
	shellSource   = regexp.MustCompile(`(?m)^\s*(?:source|\.)\s+([^\n;&|]+)`)
	shellPath     = regexp.MustCompile(`[\w./-]*[\w-]+\.(?:sh|bash)\b`)
	elixirUse     = regexp.MustCompile(`(?m)^\s*(?:alias|import|use|require)\s+([A-Z][\w.]*)(\{[^}]*\})?`)
	swiftImport   = regexp.MustCompile(`(?m)^\s*(?:@\w+\s+)*import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?([A-Za-z_]\w*)`)
)

func extractTextImports(src []byte, lang string) []string {
	text := string(src)
	var out []string
	seen := map[string]bool{}
	add := func(spec string) {
		if spec != "" && !seen[spec] {
			seen[spec] = true
			out = append(out, spec)
		}
	}
	switch lang {
	case "c", "cpp":
		for _, m := range cInclude.FindAllStringSubmatch(text, -1) {
			if m[1] == `"` {
				add(SpecIncludeLocal + strings.TrimSpace(m[2]))
			} else {
				add(SpecIncludeSystem + strings.TrimSpace(m[2]))
			}
		}
	case "java":
		for _, m := range javaImport.FindAllStringSubmatch(text, -1) {
			add(SpecJVM + m[1] + m[2])
		}
	case "kotlin":
		for _, m := range kotlinImport.FindAllStringSubmatch(text, -1) {
			add(SpecJVM + m[1] + m[2])
		}
	case "rust":
		for _, m := range rustMod.FindAllStringSubmatch(text, -1) {
			add(SpecRustMod + m[1])
		}
		for _, m := range rustUse.FindAllStringSubmatch(text, -1) {
			for _, path := range expandRustUse(m[1]) {
				add(SpecRustUse + path)
			}
		}
	case "ruby":
		for _, m := range rubyRelative.FindAllStringSubmatch(text, -1) {
			add(SpecRubyRelative + m[1])
		}
		for _, m := range rubyRequire.FindAllStringSubmatch(text, -1) {
			add(SpecRuby + m[1])
		}
	case "php":
		for _, m := range phpInclude.FindAllStringSubmatch(text, -1) {
			add(SpecPHPFile + m[2])
		}
		for _, m := range phpUse.FindAllStringSubmatch(text, -1) {
			add(SpecPHPNamespace + m[1])
		}
		for _, m := range phpGroupedUse.FindAllStringSubmatch(text, -1) {
			for _, part := range strings.Split(m[2], ",") {
				name := strings.TrimSpace(strings.SplitN(strings.TrimSpace(part), " as ", 2)[0])
				if name != "" {
					add(SpecPHPNamespace + m[1] + `\` + name)
				}
			}
		}
	case "swift":
		for _, m := range swiftImport.FindAllStringSubmatch(text, -1) {
			add(SpecSwift + m[1])
		}
	case "scala":
		for _, m := range scalaImport.FindAllStringSubmatch(text, -1) {
			for _, name := range expandScalaImport(m[1]) {
				add(SpecJVM + name)
			}
		}
	case "groovy":
		for _, m := range groovyImport.FindAllStringSubmatch(text, -1) {
			add(SpecJVM + m[1] + m[2])
		}
	case "lua":
		for _, m := range luaRequire.FindAllStringSubmatch(text, -1) {
			add(SpecLua + m[1])
		}
	case "bash":
		for _, m := range shellSource.FindAllStringSubmatch(text, -1) {
			// `source "$DIR/lib/util.sh"`: what follows the variables is the path.
			if path := shellPath.FindString(m[1]); path != "" {
				add(SpecShell + strings.TrimPrefix(strings.TrimPrefix(path, "./"), "/"))
			}
		}
	case "elixir":
		for _, m := range elixirUse.FindAllStringSubmatch(text, -1) {
			if m[2] == "" {
				add(SpecElixir + strings.TrimSuffix(m[1], "."))
				continue
			}
			// alias Shop.{Cart, Order}
			for _, part := range strings.Split(strings.Trim(m[2], "{}"), ",") {
				if name := strings.TrimSpace(part); name != "" {
					add(SpecElixir + m[1] + name)
				}
			}
		}
	}
	return out
}

// expandScalaImport turns `a.b.{C, D => E}`, `a.b._` and `a.b.C` into the JVM
// names they import (a.b.* for a wildcard).
func expandScalaImport(clause string) []string {
	if i := strings.Index(clause, "//"); i >= 0 {
		clause = clause[:i]
	}
	clause = strings.TrimSpace(clause)
	var out []string
	one := func(prefix, selector string) {
		// A rename imports the name on the left: `C => D`, `C as D`.
		for _, sep := range []string{"=>", " as "} {
			if i := strings.Index(selector, sep); i >= 0 {
				selector = selector[:i]
			}
		}
		selector = strings.TrimSpace(selector)
		switch selector {
		case "":
		case "_", "*", "given":
			out = append(out, prefix+".*")
		default:
			out = append(out, prefix+"."+selector)
		}
	}
	if open := strings.Index(clause, "{"); open > 0 {
		prefix := strings.TrimSuffix(strings.TrimSpace(clause[:open]), ".")
		for _, selector := range strings.Split(strings.Trim(clause[open:], "{} "), ",") {
			one(prefix, selector)
		}
		return out
	}
	if dot := strings.LastIndex(clause, "."); dot > 0 {
		one(clause[:dot], clause[dot+1:])
	}
	return out
}

// expandRustUse turns `crate::a::{b, c::D}` into crate::a::b and
// crate::a::c::D. Only paths inside this crate (crate, self, super) can name
// a project file; other crates are dependencies.
func expandRustUse(tree string) []string {
	tree = rustAlias.ReplaceAllString(tree, "")
	tree = strings.Join(strings.Fields(tree), "")
	var out []string
	var walk func(prefix, rest string)
	walk = func(prefix, rest string) {
		open := strings.Index(rest, "{")
		if open < 0 {
			path := prefix + rest
			path = strings.TrimSuffix(strings.TrimSuffix(path, "::*"), "::self")
			out = append(out, path)
			return
		}
		head := prefix + rest[:open]
		body := rest[open+1:]
		if end := strings.LastIndex(body, "}"); end >= 0 {
			body = body[:end]
		}
		depth, start := 0, 0
		for i, ch := range body {
			switch ch {
			case '{':
				depth++
			case '}':
				depth--
			case ',':
				if depth == 0 {
					walk(head, body[start:i])
					start = i + 1
				}
			}
		}
		if start < len(body) {
			walk(head, body[start:])
		}
	}
	walk("", tree)
	var local []string
	for _, path := range out {
		if strings.HasPrefix(path, "crate::") || strings.HasPrefix(path, "self::") || strings.HasPrefix(path, "super::") {
			local = append(local, path)
		}
	}
	return local
}
