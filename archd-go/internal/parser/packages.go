package parser

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
)

// PackageRef is one use of an external package: the evidence infra detection
// starts from (INFRA_LAYER_PLAN.md L2). Package is the installable name -
// "@aws-sdk/client-s3", "stripe", "github.com/lib/pq" - not the subpath.
type PackageRef struct {
	Package string
	Line    int
}

// EnvRef is one read of an environment variable by name. Values are never read.
type EnvRef struct {
	Name string
	Line int
}

// nodeBuiltins are Node's own modules; they are not dependencies.
var nodeBuiltins = map[string]bool{
	"assert": true, "async_hooks": true, "buffer": true, "child_process": true, "cluster": true,
	"console": true, "crypto": true, "dgram": true, "diagnostics_channel": true, "dns": true,
	"events": true, "fs": true, "http": true, "http2": true, "https": true, "inspector": true,
	"module": true, "net": true, "os": true, "path": true, "perf_hooks": true, "process": true,
	"querystring": true, "readline": true, "repl": true, "sqlite": true, "stream": true,
	"string_decoder": true, "test": true, "timers": true, "tls": true, "tty": true, "url": true,
	"util": true, "v8": true, "vm": true, "worker_threads": true, "zlib": true,
}

// jsPackageName reduces a bare specifier to its package: "@scope/name/sub" →
// "@scope/name", "name/sub" → "name". Built-ins return "".
func jsPackageName(spec string) string {
	if strings.HasPrefix(spec, "node:") || strings.HasPrefix(spec, "bun:") {
		return ""
	}
	parts := strings.Split(spec, "/")
	name := parts[0]
	if strings.HasPrefix(spec, "@") && len(parts) > 1 {
		name = parts[0] + "/" + parts[1]
	}
	if nodeBuiltins[strings.TrimSuffix(name, "/promises")] {
		return ""
	}
	return name
}

// extractJSModuleRefs finds every module a JS/TS file loads: static imports,
// `export ... from`, require() and dynamic import(). Bare specifiers become
// PackageRefs; relative specifiers loaded through require() or import() are
// returned so the file graph includes them (static relative imports are already
// in Result.Imports).
func extractJSModuleRefs(root *sitter.Node, src []byte, relPath string) (packages []PackageRef, dynamicRelative []string) {
	base := filepath.Dir(relPath)
	record := func(spec string, line int, dynamic bool) {
		if spec == "" {
			return
		}
		if strings.HasPrefix(spec, ".") {
			if dynamic {
				dynamicRelative = append(dynamicRelative, filepath.ToSlash(filepath.Join(base, spec)))
			}
			return
		}
		if name := jsPackageName(spec); name != "" {
			packages = append(packages, PackageRef{Package: name, Line: line})
		}
	}
	stringArg := func(call *sitter.Node) string {
		args := call.ChildByFieldName("arguments")
		if args == nil {
			return ""
		}
		for i := 0; i < int(args.NamedChildCount()); i++ {
			arg := args.NamedChild(i)
			if arg.Type() == "string" {
				return unquote(arg.Content(src))
			}
			return "" // a computed specifier is not evidence
		}
		return ""
	}
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		line := int(node.StartPoint().Row) + 1
		switch node.Type() {
		case "import_statement", "export_statement":
			if source := node.ChildByFieldName("source"); source != nil {
				record(unquote(source.Content(src)), line, false)
			} else if node.Type() == "import_statement" {
				for i := 0; i < int(node.ChildCount()); i++ {
					if child := node.Child(i); child.Type() == "string" {
						record(unquote(child.Content(src)), line, false)
						break
					}
				}
			}
		case "call_expression":
			if fn := node.ChildByFieldName("function"); fn != nil {
				if fn.Type() == "import" || (fn.Type() == "identifier" && fn.Content(src) == "require") {
					record(stringArg(node), line, true)
				}
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return packages, dynamicRelative
}

// extractPythonPackages records the top-level module of every absolute import.
func extractPythonPackages(root *sitter.Node, src []byte) []PackageRef {
	var out []PackageRef
	add := func(dotted string, line int) {
		if dotted == "" || strings.HasPrefix(dotted, ".") {
			return
		}
		// The full module: google.cloud.storage, not google. Detection matches
		// a service's import name as a prefix at a dot.
		out = append(out, PackageRef{Package: dotted, Line: line})
	}
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		line := int(node.StartPoint().Row) + 1
		switch node.Type() {
		case "import_statement":
			for i := 0; i < int(node.NamedChildCount()); i++ {
				child := node.NamedChild(i)
				switch child.Type() {
				case "dotted_name":
					add(child.Content(src), line)
				case "aliased_import":
					if name := child.ChildByFieldName("name"); name != nil {
						add(name.Content(src), line)
					}
				}
			}
		case "import_from_statement":
			if module := node.ChildByFieldName("module_name"); module != nil && module.Type() == "dotted_name" {
				add(module.Content(src), line)
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return out
}

// extractGoPackages records every non-standard-library import path.
func extractGoPackages(root *sitter.Node, src []byte) []PackageRef {
	var out []PackageRef
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		if node.Type() == "import_spec" {
			if path := node.ChildByFieldName("path"); path != nil {
				spec := unquote(path.Content(src))
				// The standard library has no dot in its first element.
				if first := strings.Split(spec, "/")[0]; strings.Contains(first, ".") {
					out = append(out, PackageRef{Package: spec, Line: int(node.StartPoint().Row) + 1})
				}
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return out
}

var envPatterns = map[string][]*regexp.Regexp{
	"js": {
		regexp.MustCompile(`process\.env\.([A-Z_][A-Z0-9_]*)`),
		regexp.MustCompile(`process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]`),
		regexp.MustCompile(`import\.meta\.env\.([A-Z_][A-Z0-9_]*)`),
	},
	"python": {
		regexp.MustCompile(`os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]`),
		regexp.MustCompile(`os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]`),
		regexp.MustCompile(`os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]`),
	},
	"go": {
		regexp.MustCompile(`os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"`),
	},
}

// extractEnvReads finds environment variables read by name. It is a text
// scan: env access has a handful of fixed spellings per language, and a name
// written in a comment is harmless evidence of intent.
func extractEnvReads(src []byte, lang string) []EnvRef {
	family := lang
	switch lang {
	case "typescript", "tsx", "javascript", "jsx":
		family = "js"
	}
	patterns := envPatterns[family]
	if len(patterns) == 0 {
		return nil
	}
	var out []EnvRef
	lineStarts := []int{0}
	for i, b := range src {
		if b == '\n' {
			lineStarts = append(lineStarts, i+1)
		}
	}
	lineOf := func(offset int) int {
		lo, hi := 0, len(lineStarts)-1
		for lo < hi {
			mid := (lo + hi + 1) / 2
			if lineStarts[mid] <= offset {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		return lo + 1
	}
	seen := map[string]bool{}
	for _, pattern := range patterns {
		for _, match := range pattern.FindAllSubmatchIndex(src, -1) {
			name := string(src[match[2]:match[3]])
			line := lineOf(match[0])
			key := name + ":" + strconv.Itoa(line)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, EnvRef{Name: name, Line: line})
		}
	}
	return out
}
