package rustrecorder

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// Cargo runs this test binary as the compiler wrapper, the way it runs archd
// during a run.
func TestMain(m *testing.M) {
	if os.Getenv(WrapperEnv) != "" && len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-test.") {
		os.Exit(RunWrapper(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func TestInstrumentKeepsEveryLineAndSkipsWhatItCannotRecord(t *testing.T) {
	src := "pub const fn k() -> u8 { 1 }\nfn attr() { #![allow(dead_code)] }\npub fn add(a: i32, (b, c): (i32, i32), _: u8) -> i32 {\n    if a > 0 { return a + b; }\n    let f = || { return 1; };\n    a + c + f()\n}\n"
	out, funcs, err := Instrument([]byte(src), "/w/src/lib.rs", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if strings.Count(got, "\n") != strings.Count(src, "\n") {
		t.Fatalf("lines moved:\n%s", got)
	}
	lines := strings.Split(got, "\n")
	if lines[0] != "pub const fn k() -> u8 { 1 }" || lines[1] != "fn attr() { #![allow(dead_code)] }" {
		t.Fatalf("a const fn and a body with inner attributes are left alone:\n%s\n%s", lines[0], lines[1])
	}
	for _, want := range []string{
		`F::new("add", r##"/w/src/lib.rs"##, 3, "a", 0, true)`, // only `a` has a name of its own
		"let __axr: i32 = {",
		"return { let __axv: i32 = a + b;",
		"let f = || { return 1; };", // the closure's return is the closure's
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if len(funcs) != 3 || funcs[2].Name != "add" || funcs[2].StartLine != 3 || funcs[2].EndLine != 7 {
		t.Fatalf("funcs = %+v", funcs)
	}
	// Tiers: without return capture, then not at all.
	entry, _, _ := Instrument([]byte(src), "/w/src/lib.rs", map[int]int{2: TierEntry})
	if strings.Contains(string(entry), "__axr") || !strings.Contains(string(entry), "enter(&__AXF)") {
		t.Fatalf("entry tier:\n%s", entry)
	}
	none, _, _ := Instrument([]byte(src), "/w/src/lib.rs", map[int]int{2: TierNone})
	if string(none) != src {
		t.Fatalf("tier none must be the source itself:\n%s", none)
	}
}

// recorderVersion is what the test runs pass as the recorder's version; a
// test changes it to stand in for an Ambio update.
var recorderVersion = Version()

type evidence struct {
	Functions []struct {
		Name   string `json:"name"`
		File   string `json:"file"`
		Line   int    `json:"line"`
		Calls  int    `json:"calls"`
		Errors int    `json:"errors"`
	} `json:"functions"`
	Edges []struct {
		From  struct{ Name string } `json:"from"`
		To    struct{ Name string } `json:"to"`
		Calls int                   `json:"calls"`
	} `json:"edges"`
	Watched []struct {
		Symbol  string `json:"symbol"`
		Calls   int    `json:"calls"`
		Errors  int    `json:"errors"`
		Samples []struct {
			Args     string   `json:"args"`
			Returned string   `json:"returned"`
			Threw    string   `json:"threw"`
			Mutated  []string `json:"mutated"`
		} `json:"samples"`
		Mutations []struct {
			Path string `json:"path"`
		} `json:"mutations"`
		Drift []struct {
			Path string `json:"path"`
		} `json:"drift"`
	} `json:"watched"`
	Uncaught []struct {
		What  string `json:"what"`
		Stack string `json:"stack"`
	} `json:"uncaught"`
}

// cargoRun builds and runs a crate, ordinarily or under the recorder, and
// returns the program's own output and the evidence it wrote.
func cargoRun(t *testing.T, dir string, record bool, watches []map[string]string, args ...string) (string, []evidence) {
	t.Helper()
	cmd := exec.Command("cargo", args...)
	cmd.Dir = dir
	cmd.Env = cargoEnv(dir, record, watches)
	evidenceDir := filepath.Join(dir, ".evidence")
	out, _ := cmd.CombinedOutput()
	var docs []evidence
	entries, _ := os.ReadDir(evidenceDir)
	for _, e := range entries {
		raw, err := os.ReadFile(filepath.Join(evidenceDir, e.Name()))
		if err != nil || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		var doc evidence
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatalf("%s: %v\n%s", e.Name(), err, raw)
		}
		docs = append(docs, doc)
	}
	return string(out), docs
}

func cargoEnv(dir string, record bool, watches []map[string]string) []string {
	env := append(os.Environ(), "CARGO_TERM_COLOR=never")
	if record {
		exe, _ := os.Executable()
		root, _ := filepath.EvalSymlinks(dir)
		watchJSON, _ := json.Marshal(watches)
		env = append(env, "RUSTC_WORKSPACE_WRAPPER="+exe, WrapperEnv+"=1", VersionEnv+"="+recorderVersion, "AMBIO_RECORDER_DEBUG=1",
			"AMBIO_EVIDENCE_DIR="+filepath.Join(dir, ".evidence"), "AMBIO_WORKSPACE_ROOT="+root, "AMBIO_WATCHES="+string(watchJSON))
		if buildDir := BuildDir(runtime.GOOS, ""); buildDir != "" {
			env = append(env, BuildDirEnv+"="+buildDir)
		}
	}
	return env
}

// cargoExplain is what Cargo says about a recorded build when no evidence
// came of it: whether it rebuilt, and how it ran the compiler.
func cargoExplain(dir string, watches []map[string]string) string {
	cmd := exec.Command("cargo", "build", "-v")
	cmd.Dir = dir
	cmd.Env = append(cargoEnv(dir, true, watches), "CARGO_LOG=cargo::core::compiler::fingerprint=info")
	out, _ := cmd.CombinedOutput()
	return string(out)
}

// slashed spells a panic location the same on every host: Rust prints
// src\main.rs on Windows.
func slashed(out string) string { return strings.ReplaceAll(out, `\`, "/") }

// programOutput drops Cargo's progress lines and the thread id a panic prints.
func programOutput(out string) string {
	var kept []string
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Compiling ") || strings.HasPrefix(trimmed, "Finished ") || strings.HasPrefix(trimmed, "Running ") || strings.HasPrefix(trimmed, "[ambio]") {
			continue
		}
		if i := strings.Index(line, "' ("); i >= 0 && strings.Contains(line, "panicked at") {
			if j := strings.Index(line[i:], ")"); j >= 0 {
				line = line[:i+1] + line[i+j+1:]
			}
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func crate(t *testing.T, files map[string]string) string {
	t.Helper()
	if _, err := exec.LookPath("cargo"); err != nil {
		t.Skip("cargo is not installed")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files["Cargo.toml"] = "[package]\nname = \"shop\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"
	for rel, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const stockSource = `use std::collections::BTreeMap;

#[derive(Debug)]
pub struct Stock {
    levels: BTreeMap<String, i64>,
    reservations: u32,
}

impl Stock {
    pub fn new() -> Self {
        let mut levels = BTreeMap::new();
        levels.insert("widget".to_string(), 10);
        Stock { levels, reservations: 0 }
    }

    pub fn reserve(&mut self, item: &str, qty: i64) -> Result<i64, String> {
        let have = *self.levels.get(item).unwrap_or(&0);
        if qty > have {
            return Err(format!("not enough {item}"));
        }
        self.levels.insert(item.to_string(), have - qty);
        self.reservations += 1;
        Ok(have - qty)
    }
}

pub fn price(item: &str) -> f64 {
    match lookup(item) {
        Ok(p) => p,
        Err(_) => 0.5,
    }
}

fn lookup(item: &str) -> Result<f64, String> {
    if item == "gadget" {
        return Err(format!("no price for {item}"));
    }
    Ok(2.5)
}
`

func TestRustRunRecordsArgumentsResultsMutationsAndThePanic(t *testing.T) {
	dir := crate(t, map[string]string{
		"src/stock.rs": stockSource,
		"src/main.rs": `mod stock;

fn main() {
    let mut s = stock::Stock::new();
    for _ in 0..3 {
        s.reserve("widget", 3).unwrap();
    }
    println!("{} {}", stock::price("widget"), stock::price("gadget"));
    s.reserve("widget", 3).unwrap();
}
`,
	})
	plain, _ := cargoRun(t, dir, false, nil, "run", "-q")
	file := filepath.Join(dir, "src", "stock.rs")
	out, docs := cargoRun(t, dir, true, []map[string]string{{"absPath": file, "symbol": "reserve"}, {"absPath": file, "symbol": "price"}}, "run", "-q")
	// The program prints what it would have: same panic, same place.
	// (Older compilers word the panic line differently; the place is the same.)
	if programOutput(out) != programOutput(plain) || !strings.Contains(out, "panicked at") || !strings.Contains(slashed(out), "src/main.rs:9:28") {
		t.Fatalf("output differs.\nordinary:\n%s\nrecorded:\n%s", plain, out)
	}
	if strings.Contains(out, "warning") {
		t.Fatalf("the rewrite adds no warnings:\n%s", out)
	}
	if len(docs) != 1 {
		t.Fatalf("%d evidence documents:\n%s\ncargo build -v:\n%s", len(docs), out, cargoExplain(dir, []map[string]string{{"absPath": file, "symbol": "reserve"}}))
	}
	doc := docs[0]
	calls := map[string][2]int{}
	for _, f := range doc.Functions {
		calls[f.Name] = [2]int{f.Calls, f.Errors}
	}
	// lookup is not watched; its Err still counts. price handles it: no error.
	want := map[string][2]int{"main": {1, 1}, "new": {1, 0}, "reserve": {4, 1}, "price": {2, 0}, "lookup": {2, 1}}
	for name, w := range want {
		if calls[name] != w {
			t.Errorf("%s: calls, errors = %v, want %v", name, calls[name], w)
		}
	}
	var reserve, price = -1, -1
	for i, w := range doc.Watched {
		switch w.Symbol {
		case "reserve":
			reserve = i
		case "price":
			price = i
		}
	}
	if reserve < 0 || price < 0 {
		t.Fatalf("watched: %+v", doc.Watched)
	}
	r := doc.Watched[reserve]
	if r.Samples[0].Args != `{"self": Stock { levels: {"widget": 10}, reservations: 0 }, "item": "widget", "qty": 3}` || r.Samples[0].Returned != "Ok(7)" {
		t.Errorf("first call: %+v", r.Samples[0])
	}
	if strings.Join(r.Samples[0].Mutated, "; ") != "self.levels.widget: 10 → 7; self.reservations: 0 → 1" {
		t.Errorf("mutated: %v", r.Samples[0].Mutated)
	}
	// A function fails by returning Err, written like Go's returned errors.
	if r.Samples[3].Threw != `error: "not enough widget"` {
		t.Errorf("failed call: %+v", r.Samples[3])
	}
	if p := doc.Watched[price]; p.Samples[0].Returned != "2.5" || p.Samples[1].Returned != "0.5" || p.Errors != 0 {
		t.Errorf("price: %+v", p.Samples)
	}
	if len(doc.Uncaught) != 1 || !strings.HasPrefix(doc.Uncaught[0].What, "panic: called `Result::unwrap()` on an `Err` value") ||
		!strings.Contains(doc.Uncaught[0].Stack, filepath.Join(dir, "src", "main.rs")+":9:1") {
		t.Errorf("uncaught: %+v", doc.Uncaught)
	}

	// Cargo rebuilds when the user's file changes, not the copy: the
	// dependency file names their sources.
	deps, _ := filepath.Glob(filepath.Join(dir, "target", "debug", "deps", "shop-*.d"))
	var listed string
	for _, d := range deps {
		raw, _ := os.ReadFile(d)
		listed += string(raw)
	}
	if strings.Contains(listed, "ambio-src") || !strings.Contains(listed, "src/stock.rs") {
		t.Errorf("dependency files:\n%s", listed)
	}
}

// Everything a source rewrite of Rust can trip on. The recorded program must
// print what the ordinary one prints, and a function whose rewrite does not
// compile must be recorded less, never break the build.
const tortureSource = `use std::collections::HashMap;
use std::fmt::Display;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

pub struct Opaque(pub u8);
#[derive(Debug, Clone, PartialEq)]
pub enum Level { Low, High(u8) }
#[derive(Debug)]
pub struct Point { pub x: i32, pub y: i32 }

pub trait Shape {
    fn area(&self) -> f64;
    fn label(&self) -> String { format!("shape:{:.1}", self.area()) }
}
impl Shape for Point {
    fn area(&self) -> f64 { (self.x * self.y) as f64 }
}
impl std::ops::Add for Point {
    type Output = Point;
    fn add(self, o: Point) -> Point { Point { x: self.x + o.x, y: self.y + o.y } }
}

pub const fn konst(a: u8) -> u8 { a + 1 }
pub fn unit(v: &mut Vec<i32>) { v.push(1) }
pub fn early(v: &[i32]) -> Option<i32> { let first = v.first()?; if *first > 5 { return None; } Some(*first * 2) }
pub fn chain(s: &str) -> Result<i32, std::num::ParseIntError> { let n: i32 = s.parse()?; Ok(n + 1) }
pub fn boxed(n: i32) -> Box<dyn Shape> { Box::new(Point { x: n, y: n }) }
pub fn iter(n: u32) -> impl Iterator<Item = u32> { (0..n).filter(|x| x % 2 == 0) }
pub fn borrow<'a>(m: &'a HashMap<String, String>, k: &str) -> &'a str { match m.get(k) { Some(v) => v, None => "none" } }
pub fn generic<T: Display + Clone>(x: T, times: usize) -> Vec<String> { (0..times).map(|_| x.to_string()).collect() }
pub fn tuple((a, b): (i32, i32), _: u8, mut c: i32) -> (i32, String) { c += a; (c + b, "t".into()) }
pub fn closure(k: i32) -> i32 { let f = |x: i32| -> i32 { if x > 100 { return 0; } x + k }; f(1) + f(200) }
pub fn nested(x: i32) -> i32 { fn inner(y: i32) -> i32 { y * 3 } inner(x) + 1 }
pub fn never(flag: bool) -> ! { if flag { panic!("never") } std::process::exit(0) }
pub fn looped(n: i32) -> i32 { let mut i = 0; let r = loop { i += 1; if i > n { break i * 2; } }; r }
pub fn matched(l: &Level) -> u8 { match l { Level::Low => return 0, Level::High(n) => *n } }
pub fn opaque(o: Opaque, p: &Opaque) -> u8 { o.0 + p.0 }
pub fn default_into() -> String { Default::default() }
pub fn literal() -> u8 { 1 }
pub unsafe fn raw(p: *const i32) -> i32 { *p }
pub extern "C" fn cabi(a: i32) -> i32 { a * 2 }
pub fn macro_return(v: Vec<i32>) -> Result<i32, String> { if v.is_empty() { fail!("empty"); } Ok(v[0]) }
pub fn store<'a>(slot: &mut Option<&'a mut Vec<i32>>, v: &'a mut Vec<i32>) { *slot = Some(v); }
pub async fn later(x: i32) -> i32 { ready().await; if x < 0 { return -1; } x + 1 }
async fn ready() {}
pub fn question(a: &str, b: &str) -> Result<i32, String> { let x = chain(a).map_err(|e| e.to_string())?; let y = chain(b).map_err(|e| e.to_string())?; Ok(x + y) }

#[macro_export]
macro_rules! fail { ($m:expr) => { return Err($m.to_string()) }; }

pub struct Counter { pub hits: u32 }
impl Counter {
    pub fn bump(&mut self) -> u32 { self.hits += 1; self.hits }
    pub fn take(self) -> u32 { self.hits }
    pub fn peek(&self) -> u32 { self.hits }
}
impl Drop for Counter { fn drop(&mut self) { self.hits = 0; } }

pub fn block_on<F: Future>(mut f: F) -> F::Output {
    fn raw() -> RawWaker { fn no(_: *const ()) {} fn clone(_: *const ()) -> RawWaker { raw() } static VT: RawWakerVTable = RawWakerVTable::new(clone, no, no, no); RawWaker::new(std::ptr::null(), &VT) }
    let waker = unsafe { Waker::from_raw(raw()) };
    let mut cx = Context::from_waker(&waker);
    let mut f = unsafe { Pin::new_unchecked(&mut f) };
    loop { if let Poll::Ready(v) = f.as_mut().poll(&mut cx) { return v; } }
}
`

func TestRustRecordedBuildBehavesLikeTheOrdinaryOne(t *testing.T) {
	dir := crate(t, map[string]string{
		"src/lib.rs": tortureSource,
		"src/main.rs": `use shop::*;
use std::collections::HashMap;

fn main() {
    let mut o = String::new();
    let p = Point { x: 2, y: 3 } + Point { x: 1, y: 1 };
    o += &format!("{} {} {} ", p.label(), konst(1), boxed(2).area());
    let mut v = vec![]; unit(&mut v);
    o += &format!("{:?}{:?}{:?} ", early(&[2]), early(&[9]), early(&[]));
    o += &format!("{:?}{} ", chain("41"), chain("x").is_err());
    o += &format!("{:?} ", iter(5).collect::<Vec<_>>());
    let mut m = HashMap::new(); m.insert("k".to_string(), "v".to_string());
    o += &format!("{}{} {:?} {:?} ", borrow(&m, "k"), borrow(&m, "z"), generic(7u8, 2), tuple((1, 2), 0, 3));
    o += &format!("{} {} {} {}{} ", closure(2), nested(2), looped(3), matched(&Level::Low), matched(&Level::High(4)));
    o += &format!("{} {:?} {} {} {} ", opaque(Opaque(1), &Opaque(2)), default_into(), literal(), unsafe { raw(&5) }, cabi(4));
    o += &format!("{:?}{:?} ", macro_return(vec![]), macro_return(vec![3]));
    let mut held = vec![1]; let mut slot = None; store(&mut slot, &mut held); o += &format!("{} ", slot.map(|s| s.len()).unwrap_or(0));
    o += &format!("{}{} {:?}{:?} ", block_on(later(1)), block_on(later(-5)), question("1", "2"), question("1", "x").is_err());
    let mut c = Counter { hits: 0 }; c.bump(); o += &format!("{}{}", c.peek(), c.take());
    println!("{o}");
    never(false)
}
`,
	})
	plain, _ := cargoRun(t, dir, false, nil, "run", "-q")
	if !strings.Contains(plain, "shape:12.0 2 4 ") {
		t.Fatalf("the ordinary build is the baseline:\n%s", plain)
	}
	file := filepath.Join(dir, "src", "lib.rs")
	out, docs := cargoRun(t, dir, true, []map[string]string{{"absPath": file, "symbol": "*"}}, "run", "-q")
	if programOutput(out) != programOutput(plain) {
		t.Fatalf("output differs.\nordinary:\n%s\nrecorded:\n%s", plain, out)
	}
	if strings.Contains(out, "warning") {
		t.Fatalf("the rewrite adds no warnings:\n%s", out)
	}
	names := map[string]bool{}
	samples := map[string]string{}
	for _, doc := range docs {
		for _, f := range doc.Functions {
			names[f.Name] = true
		}
		for _, w := range doc.Watched {
			for _, s := range w.Samples {
				outcome := s.Returned
				if s.Threw != "" {
					outcome = "FAILED " + s.Threw
				}
				samples[w.Symbol] += s.Args + " -> " + outcome + "\n"
			}
		}
	}
	var recorded []string
	for name := range names {
		recorded = append(recorded, name)
	}
	sort.Strings(recorded)
	for _, expected := range []string{"area", "label", "add", "unit", "early", "chain", "boxed", "iter", "borrow", "generic", "tuple", "closure", "nested", "inner",
		"never", "looped", "matched", "opaque", "default_into", "literal", "raw", "cabi", "macro_return", "store", "later", "ready", "question", "bump", "take", "peek", "drop", "block_on", "main"} {
		if !names[expected] {
			t.Errorf("%s was not recorded; recorded: %v\n%s", expected, recorded, out)
		}
	}
	if names["konst"] {
		t.Error("a const fn cannot be recorded")
	}
	for symbol, want := range map[string]string{
		"early": "{\"v\": [2]} -> Some(4)\n{\"v\": [9]} -> None\n{\"v\": []} -> None\n", // `return None`, then `?` on an empty slice
		// called from main, then four times by question
		"chain":        "{\"s\": \"41\"} -> Ok(42)\n{\"s\": \"x\"} -> FAILED error: (propagated with `?`)\n{\"s\": \"1\"} -> Ok(2)\n{\"s\": \"2\"} -> Ok(3)\n{\"s\": \"1\"} -> Ok(2)\n{\"s\": \"x\"} -> FAILED error: (propagated with `?`)\n",
		"opaque":       "{\"o\": <Opaque>, \"p\": <Opaque>} -> 3\n", // no Debug: named, not an error
		"macro_return": "{\"v\": []} -> FAILED error: (propagated with `?`)\n{\"v\": [3]} -> Ok(3)\n",
		"later":        "{\"x\": 1} -> 2\n{\"x\": -5} -> -1\n",
		"iter":         "{\"n\": 5} -> (not captured)\n", // impl Trait cannot be named
		"tuple":        "{\"c\": 3} -> (6, \"t\")\n",
		"default_into": "{} -> \"\"\n",
		"literal":      "{} -> 1\n",
	} {
		if samples[symbol] != want {
			t.Errorf("%s:\n got %q\nwant %q", symbol, samples[symbol], want)
		}
	}
}

// `cargo test`: the harness runs each test on its own thread and the process
// ends through exit(), so evidence is flushed by the C exit handler. Edition
// 2024, where an extern block must be `unsafe extern`.
func TestRustCargoTestOnEdition2024(t *testing.T) {
	dir := crate(t, map[string]string{
		"src/lib.rs": `pub struct Ledger { pub discount: i64 }

pub fn total(ledger: &Ledger, amount: i64) -> i64 {
    amount - ledger.discount
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backfilled_invoice_keeps_its_price() {
        let mut ledger = Box::new(Ledger { discount: 10 });
        assert_eq!(total(&ledger, 100), 90);
        ledger.discount += 5;
        assert_eq!(total(&ledger, 100), 90);
    }
}
`,
	})
	manifest := filepath.Join(dir, "Cargo.toml")
	if err := os.WriteFile(manifest, []byte("[package]\nname = \"shop\"\nversion = \"0.1.0\"\nedition = \"2024\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "src", "lib.rs")
	out, docs := cargoRun(t, dir, true, []map[string]string{{"absPath": file, "symbol": "total"}}, "test", "-q")
	if strings.Contains(out, "failed to parse manifest") {
		t.Skip("this toolchain predates the 2024 edition")
	}
	if !strings.Contains(out, "test result: FAILED. 0 passed; 1 failed") || !strings.Contains(slashed(out), "src/lib.rs:16:9") {
		t.Fatalf("the test fails as it would have, at its own line:\n%s", out)
	}
	if strings.Contains(out, "recorded less") || strings.Contains(out, "not recording") {
		t.Fatalf("nothing should need demoting:\n%s", out)
	}
	if len(docs) != 1 || len(docs[0].Watched) != 1 {
		t.Fatalf("evidence: %+v\n%s", docs, out)
	}
	w := docs[0].Watched[0]
	// Ledger has no Debug: its value is named, and the results still tell the story.
	if w.Calls != 2 || w.Samples[0].Returned != "90" || w.Samples[1].Returned != "85" || w.Samples[0].Args != `{"ledger": <Ledger>, "amount": 100}` {
		t.Fatalf("total: %+v", w.Samples)
	}
	// A failing test is the harness's to report, not an uncaught crash.
	if len(docs[0].Uncaught) != 0 {
		t.Fatalf("uncaught: %+v", docs[0].Uncaught)
	}
}

// An instrumented crate is cached by Cargo like any other. When the recorder
// changes - an Ambio update - the cached one must not be reused: Cargo
// rebuilds because the recorder's version is part of what the crate read.
func TestRustRebuildsWhenTheRecorderChanges(t *testing.T) {
	dir := crate(t, map[string]string{"src/main.rs": "fn answer() -> i32 { 42 }\nfn main() { println!(\"{}\", answer()); }\n"})
	built := func() bool {
		out, _ := cargoRun(t, dir, true, nil, "run")
		return strings.Contains(out, "Compiling shop")
	}
	if !built() {
		t.Fatal("the first run compiles the crate")
	}
	if built() {
		t.Fatal("an unchanged crate and recorder must come from the cache")
	}
	defer func(v string) { recorderVersion = v }(recorderVersion)
	recorderVersion = "a-later-ambio"
	if !built() {
		t.Fatal("a different recorder must rebuild the crate")
	}
}
