// Package rustrecorder records Rust investigation runs with nothing installed
// (docs/INVESTIGATION_RUNTIMES.md). Cargo runs archd as the compiler wrapper
// for the workspace's own crates (RUSTC_WORKSPACE_WRAPPER); for each crate the
// wrapper compiles instrumented copies of its sources, kept under target/, and
// a recorder module that exists only in those copies. The user's files are
// never written, and wrapped builds are cached apart from ordinary ones
// (BuildDir).
//
// Each function gains code on lines it already has, and paths are remapped,
// so every panic location and every line of debug info is the user's own.
package rustrecorder

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/rust"
)

//go:embed recorder.rs.txt
var recorderSource string

// VersionEnv carries Version to the compiler. The recorder module reads it
// with option_env!, which makes it part of what Cargo's cache depends on.
const VersionEnv = "AMBIO_RECORDER_VERSION"

// BuildDirEnv is where Cargo keeps fingerprints and intermediate artifacts.
const BuildDirEnv = "CARGO_BUILD_BUILD_DIR"

// BuildDir is the build directory a recorded build uses on goos, or "" for
// Cargo's own. Cargo tells wrapped builds apart by a hash of the wrapper in
// each workspace crate's artifact names, but a Windows MSVC executable's
// name carries no hash (its PDB path is embedded), so a recorded build would
// find the ordinary build's executable up to date and record nothing. A
// build directory of its own keeps the two apart; the executable still lands
// where the user's build puts it. existing is the user's own setting, if any.
func BuildDir(goos, existing string) string {
	if goos != "windows" {
		return ""
	}
	if existing != "" {
		return existing + "/ambio-recorded"
	}
	return "{workspace-root}/target/ambio-recorded"
}

// instrumentVersion changes whenever Instrument emits different code.
const instrumentVersion = "1"

// Version identifies the recorder and the rewrite: crates instrumented by a
// different one are rebuilt.
func Version() string {
	sum := sha256.Sum256([]byte(instrumentVersion + "\n" + recorderSource))
	return hex.EncodeToString(sum[:8])
}

// How much of a function is recorded. A function whose instrumented form does
// not compile drops a tier at a time (wrapper.go) until it does.
const (
	TierFull    = iota // arguments, every return value, references after the call
	TierReturns        // arguments and return values
	TierEntry          // arguments only: the call, its time, a panic leaving it
	TierNone           // left as written
)

// Func is one function in a file, by the lines it spans: a compile error
// inside those lines is that function's rewrite not compiling.
type Func struct {
	Index              int
	Name               string
	StartLine, EndLine int // 1-based, inclusive
}

type edit struct {
	at    int
	order int
	text  string
}

const rec = "crate::__ambio_rec::"

// Instrument rewrites one Rust file. tiers gives the tier of each function by
// index (absent: TierFull). It returns the file's functions whether or not
// anything was rewritten.
func Instrument(src []byte, absPath string, tiers map[int]int) ([]byte, []Func, error) {
	parser := sitter.NewParser()
	defer parser.Close()
	parser.SetLanguage(rust.GetLanguage())
	tree, err := parser.ParseCtx(context.Background(), nil, src)
	if err != nil {
		return nil, nil, err
	}
	defer tree.Close()

	var edits []edit
	var funcs []Func
	add := func(at int, text string) {
		edits = append(edits, edit{at: at, order: len(edits), text: text})
	}
	text := func(n *sitter.Node) string { return string(src[n.StartByte():n.EndByte()]) }

	var walk func(n *sitter.Node)
	walk = func(n *sitter.Node) {
		if n.Type() == "function_item" {
			index := len(funcs)
			name := ""
			if id := n.ChildByFieldName("name"); id != nil {
				name = text(id)
			}
			funcs = append(funcs, Func{Index: index, Name: name, StartLine: int(n.StartPoint().Row) + 1, EndLine: int(n.EndPoint().Row) + 1})
			tier := tiers[index]
			if body := n.ChildByFieldName("body"); body != nil && name != "" && tier < TierNone && instrumentable(n, body, src) {
				weave(n, body, src, absPath, name, tier, add)
			}
		}
		for i := 0; i < int(n.NamedChildCount()); i++ {
			walk(n.NamedChild(i))
		}
	}
	walk(tree.RootNode())

	if len(edits) == 0 {
		return src, funcs, nil
	}
	sort.SliceStable(edits, func(i, j int) bool {
		if edits[i].at != edits[j].at {
			return edits[i].at < edits[j].at
		}
		return edits[i].order < edits[j].order
	})
	var out strings.Builder
	last := 0
	for _, e := range edits {
		out.Write(src[last:e.at])
		out.WriteString(e.text)
		last = e.at
	}
	out.Write(src[last:])
	return []byte(out.String()), funcs, nil
}

func instrumentable(fn, body *sitter.Node, src []byte) bool {
	for i := 0; i < int(fn.NamedChildCount()); i++ {
		child := fn.NamedChild(i)
		// A const fn cannot call the recorder.
		if child.Type() == "function_modifiers" && strings.Contains(" "+string(src[child.StartByte():child.EndByte()])+" ", " const ") {
			return false
		}
	}
	// `#![allow(..)]` must stay first in the body.
	if body.NamedChildCount() > 0 && body.NamedChild(0).Type() == "inner_attribute_item" {
		return false
	}
	return true
}

type param struct {
	name  string
	isRef bool
}

func parameters(fn *sitter.Node, src []byte) []param {
	list := fn.ChildByFieldName("parameters")
	if list == nil {
		return nil
	}
	var out []param
	for i := 0; i < int(list.NamedChildCount()); i++ {
		p := list.NamedChild(i)
		content := string(src[p.StartByte():p.EndByte()])
		switch p.Type() {
		case "self_parameter":
			out = append(out, param{name: "self", isRef: strings.Contains(content, "&")})
		case "parameter":
			pattern := p.ChildByFieldName("pattern")
			if pattern == nil || (pattern.Type() != "identifier" && pattern.Type() != "self") {
				continue // a destructuring pattern or `_`: no single name to show
			}
			typ := p.ChildByFieldName("type")
			out = append(out, param{
				name:  string(src[pattern.StartByte():pattern.EndByte()]),
				isRef: typ != nil && typ.Type() == "reference_type",
			})
		}
	}
	return out
}

func show(name string) string {
	return "(&&" + rec + "W(&" + name + ")).s()"
}

func weave(fn, body *sitter.Node, src []byte, absPath, name string, tier int, add func(int, string)) {
	params := parameters(fn, src)
	returnType := "()"
	if rt := fn.ChildByFieldName("return_type"); rt != nil {
		returnType = strings.TrimSpace(string(src[rt.StartByte():rt.EndByte()]))
	}
	// `impl Trait` cannot annotate a `let`, and `!` has no value to show.
	capture := tier <= TierReturns && returnType != "!" && !strings.Contains(" "+returnType, " impl ") && !strings.Contains(returnType, "<impl ") && !strings.HasPrefix(returnType, "impl ")
	kind := 0
	head := returnType
	if i := strings.Index(head, "<"); i >= 0 {
		head = head[:i]
	}
	switch {
	case strings.HasSuffix(head, "Result"):
		kind = 1
	case strings.HasSuffix(head, "Option"):
		kind = 2
	}

	names := make([]string, len(params))
	values := make([]string, len(params))
	addresses := make([]string, len(params))
	var after []string
	for i, p := range params {
		names[i] = p.name
		values[i] = show(p.name)
		addresses[i] = "0"
		if p.isRef {
			addresses[i] = rec + "addr(&*" + p.name + ")"
			after = append(after, fmt.Sprintf("(%d, %s)", i, show(p.name)))
		}
	}
	line := int(fn.StartPoint().Row) + 1
	if id := fn.ChildByFieldName("name"); id != nil {
		line = int(id.StartPoint().Row) + 1
	}

	// The lints the added code can trip are silenced for the function, so
	// the build's warnings stay the user's own.
	add(int(fn.StartByte()), "#[allow(unreachable_code, unused_braces, unused_variables, unused_mut, clippy::all)] ")

	var enter strings.Builder
	fmt.Fprintf(&enter, " static __AXF: %sF = %sF::new(%q, r##\"%s\"##, %d, %q, %d, %t); let __ax = %senter(&__AXF); #[allow(unused_imports)] use %s{D as _, N as _, E0 as _, E1 as _}; if __ax.w() { __ax.args(&[%s], &[%s]); }",
		rec, rec, name, absPath, line, strings.Join(names, ","), kind, capture, rec, rec, strings.Join(values, ", "), strings.Join(addresses, ", "))
	open := int(body.StartByte()) + 1
	closing := int(body.EndByte()) - 1
	if !capture {
		add(open, enter.String())
		return
	}
	fmt.Fprintf(&enter, " let __axr: %s = {", returnType)
	add(open, enter.String())

	// `return X` records X on its way out. Returns in a closure, an async
	// block or a nested function belong to those.
	var returns func(n *sitter.Node)
	returns = func(n *sitter.Node) {
		switch n.Type() {
		case "closure_expression", "async_block", "function_item":
			return
		case "return_expression":
			if n.NamedChildCount() > 0 {
				value := n.NamedChild(0)
				add(int(n.StartByte())+len("return"), fmt.Sprintf(" { let __axv: %s =", returnType))
				add(int(value.EndByte()), "; __ax.e((&&"+rec+"W(&__axv)).e()); if __ax.w() { __ax.ret("+show("__axv")+"); } __axv }")
			}
		}
		for i := 0; i < int(n.NamedChildCount()); i++ {
			returns(n.NamedChild(i))
		}
	}
	for i := 0; i < int(body.NamedChildCount()); i++ {
		returns(body.NamedChild(i))
	}

	leave := " }; __ax.e((&&" + rec + "W(&__axr)).e()); if __ax.w() { __ax.ret(" + show("__axr") + ");"
	if tier == TierFull && len(after) > 0 {
		leave += " __ax.after(&[" + strings.Join(after, ", ") + "]);"
	}
	add(closing, leave+" } __axr ")
}

// Recorder is the module appended to a crate's root file. base is where the
// compiler runs (panic locations are relative to it) and crate names the
// evidence file, since every crate in a program carries its own copy. From
// the 2024 edition an extern block must be written `unsafe extern`, which
// older compilers do not accept; so must `#[link_section]`.
func Recorder(base, crate, edition string) string {
	extern := "extern"
	// The section Windows runs a module's TLS callbacks from, the one hook
	// left when a program ends through ExitProcess.
	tls := `#[link_section = ".CRT$XLY"]`
	if edition >= "2024" {
		extern = "unsafe extern"
		tls = `#[unsafe(link_section = ".CRT$XLY")]`
	}
	replacer := strings.NewReplacer("__AMBIO_BASE__", strings.ReplaceAll(base, `\`, `\\`), "__AMBIO_CRATE__", crate, "__AMBIO_EXTERN__", extern, "__AMBIO_TLS_SECTION__", tls)
	return "\n" + replacer.Replace(recorderSource)
}
