// Package gorecorder records Go investigation runs with nothing installed
// (docs/INVESTIGATION_RUNTIMES.md). Before a run, archd rewrites the module's
// Go files into a temporary folder and hands the go command an overlay
// (`GOFLAGS=-overlay=...`) that swaps them in and adds a recorder package
// that exists only for the run. The user's files are never written, and the
// build cache stays correct because overlaid content is hashed like any file.
//
// Each function gains one statement on the line of its opening brace, and the
// recorder's registration is appended after the last line, so every line
// number - in stack traces, in runtime.Caller, in the evidence - is the
// user's own.
package gorecorder

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

//go:embed recorder.go.txt
var recorderSource string

// PackageDir is the folder name, inside each module, of the recorder package
// the overlay adds.
const PackageDir = "ambiorecgen"

type edit struct {
	at   int // byte offset
	text string
}

// Instrument rewrites one Go file so each function reports its calls to the
// recorder package at importPath. ok is false when the file is left alone
// (cgo, generated code, or nothing to record).
func Instrument(src []byte, absPath, importPath string) (out []byte, ok bool, err error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, absPath, src, parser.ParseComments)
	if err != nil {
		return nil, false, err
	}
	for _, imp := range file.Imports {
		if imp.Path.Value == `"C"` {
			return nil, false, nil // the overlay cannot carry cgo files safely
		}
	}
	if ast.IsGenerated(file) {
		return nil, false, nil
	}
	offset := func(p token.Pos) int { return fset.Position(p).Offset }
	sum := sha256.Sum256([]byte(absPath))
	base := "__ambioBase_" + hex.EncodeToString(sum[:4])

	var edits []edit
	var specs []string
	for _, decl := range file.Decls {
		fd, isFunc := decl.(*ast.FuncDecl)
		if !isFunc || fd.Body == nil || fd.Name.Name == "_" {
			continue
		}
		index := len(specs)
		specs = append(specs, fmt.Sprintf("%s:%d", fd.Name.Name, fset.Position(fd.Pos()).Line))

		var params []string
		receivers := 0
		if fd.Recv != nil {
			params = append(params, fieldNames(fd.Recv)...)
			receivers = len(params)
		}
		params = append(params, fieldNames(fd.Type.Params)...)

		// Results are captured by name; unnamed results are named for the
		// function (a body cannot tell the difference), blank ones are not.
		var results []string
		captureResults := true
		if res := fd.Type.Results; res != nil && len(res.List) > 0 {
			if len(res.List[0].Names) == 0 {
				// A single unparenthesised result gains parentheses; the "("
				// goes in before the name inserted at the same offset.
				if res.Opening == token.NoPos {
					edits = append(edits, edit{at: offset(res.List[0].Type.Pos()), text: "("})
					edits = append(edits, edit{at: offset(res.List[0].Type.End()), text: ")"})
				}
				n := 0
				for _, field := range res.List {
					name := "ambio_r" + strconv.Itoa(n)
					edits = append(edits, edit{at: offset(field.Type.Pos()), text: name + " "})
					results = append(results, name)
					n++
				}
			} else {
				for _, field := range res.List {
					for _, name := range field.Names {
						if name.Name == "_" {
							captureResults = false
						}
						results = append(results, name.Name)
					}
				}
			}
		}
		if !captureResults {
			results = nil
		}

		// The receiver is marked "@": its own state is expected to change
		// between calls, so drift does not report it.
		quoted := make([]string, len(params))
		for i, p := range params {
			if i < receivers {
				quoted[i] = strconv.Quote("@" + p)
			} else {
				quoted[i] = strconv.Quote(p)
			}
		}
		// The values at exit are read through their addresses, taken by the
		// deferred call itself: no closure is added, because Go names a
		// function's closures by their order and an added one would rename
		// every closure the user wrote (main.handler.func1 in a panic).
		var refs []string
		for _, v := range append(append([]string{}, params...), results...) {
			refs = append(refs, "&"+v)
		}
		var b strings.Builder
		fmt.Fprintf(&b, " __ambioT := ambiorec.Enter(%s + %d); defer __ambioT.Exit(); if __ambioT.Watched() { __ambioT.Args([]string{%s}%s); defer __ambioT.AfterRefs(%s) };",
			base, index, strings.Join(quoted, ", "), prefixed(params), strings.Join(refs, ", "))
		edits = append(edits, edit{at: offset(fd.Body.Lbrace) + 1, text: b.String()})
	}
	if len(specs) == 0 {
		return nil, false, nil
	}
	// The import joins the package clause's line; the registration follows
	// the last line. Neither moves a line.
	edits = append(edits, edit{at: offset(file.Name.End()), text: fmt.Sprintf("; import ambiorec %q", importPath)})
	quotedSpecs := make([]string, len(specs))
	for i, s := range specs {
		quotedSpecs[i] = strconv.Quote(s)
	}
	tail := fmt.Sprintf("\nvar %s = ambiorec.Register(%q, %s)\n", base, absPath, strings.Join(quotedSpecs, ", "))

	sort.SliceStable(edits, func(i, j int) bool { return edits[i].at < edits[j].at })
	var buf bytes.Buffer
	last := 0
	for _, e := range edits {
		buf.Write(src[last:e.at])
		buf.WriteString(e.text)
		last = e.at
	}
	buf.Write(src[last:])
	buf.WriteString(tail)
	return buf.Bytes(), true, nil
}

func fieldNames(fields *ast.FieldList) []string {
	var out []string
	if fields == nil {
		return out
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			if name.Name != "_" {
				out = append(out, name.Name)
			}
		}
	}
	return out
}

func prefixed(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return ", " + strings.Join(names, ", ")
}

// Overlay is the go command's -overlay file.
type Overlay struct {
	Replace map[string]string `json:"Replace"`
}

// Build instruments every Go module under root into dir and writes the
// overlay there. It returns the overlay's path ("" when there is no Go code
// to record) and how many files it instrumented.
func Build(root, dir string) (string, int, error) {
	modules := findModules(root)
	if len(modules) == 0 {
		return "", 0, nil
	}
	overlay := Overlay{Replace: map[string]string{}}
	count := 0
	for _, mod := range modules {
		importPath := mod.path + "/" + PackageDir
		files := goFiles(mod.dir)
		for _, file := range files {
			src, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			out, ok, err := Instrument(src, file, importPath)
			if err != nil || !ok {
				continue // a file that does not parse builds as it is
			}
			count++
			target := filepath.Join(dir, fmt.Sprintf("f%d.go", count))
			if err := os.WriteFile(target, out, 0o644); err != nil {
				return "", 0, err
			}
			replace(overlay.Replace, file, target)
		}
		recorder := filepath.Join(dir, fmt.Sprintf("recorder%d.go", len(overlay.Replace)))
		if err := os.WriteFile(recorder, []byte(recorderSource), 0o644); err != nil {
			return "", 0, err
		}
		replace(overlay.Replace, filepath.Join(mod.dir, PackageDir, "recorder.go"), recorder)
	}
	if count == 0 {
		return "", 0, nil
	}
	data, err := json.Marshal(overlay)
	if err != nil {
		return "", 0, err
	}
	path := filepath.Join(dir, "overlay.json")
	return path, count, os.WriteFile(path, data, 0o644)
}

// replace maps a file under both its given and its physical path. The go
// command looks files up by the working directory's physical path: on macOS
// /var is /private/var, and a project under any symlink would otherwise build
// uninstrumented without a word.
func replace(m map[string]string, file, target string) {
	m[file] = target
	dir, name := filepath.Split(file)
	if real, err := filepath.EvalSymlinks(filepath.Clean(dir)); err == nil {
		m[filepath.Join(real, name)] = target
	} else if parent, err := filepath.EvalSymlinks(filepath.Dir(filepath.Clean(dir))); err == nil {
		// The recorder's folder does not exist: resolve its parent instead.
		m[filepath.Join(parent, filepath.Base(filepath.Clean(dir)), name)] = target
	}
}

type module struct{ dir, path string }

var skipDirs = map[string]bool{"vendor": true, "node_modules": true, "testdata": true, ".git": true, PackageDir: true}

func findModules(root string) []module {
	var out []module
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			name := entry.Name()
			if path != root && (skipDirs[name] || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_")) {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() != "go.mod" {
			return nil
		}
		if modPath := modulePath(path); modPath != "" {
			out = append(out, module{dir: filepath.Dir(path), path: modPath})
		}
		return nil
	})
	return out
}

func modulePath(goMod string) string {
	data, err := os.ReadFile(goMod)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "module" {
			return strings.Trim(fields[1], `"`)
		}
	}
	return ""
}

// goFiles lists a module's Go files, not descending into nested modules.
func goFiles(modDir string) []string {
	var out []string
	_ = filepath.WalkDir(modDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path == modDir {
				return nil
			}
			name := entry.Name()
			if skipDirs[name] || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
				return filepath.SkipDir
			}
			if _, err := os.Stat(filepath.Join(path, "go.mod")); err == nil {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(entry.Name(), ".go") {
			out = append(out, path)
		}
		return nil
	})
	return out
}
