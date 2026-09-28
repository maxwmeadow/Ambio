package api

import (
	"encoding/json"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/runtime"
)

func testIndex() *fileIndex {
	idx := &fileIndex{workspaceID: "ws", byAbs: map[string]db.File{}, byRel: map[string]db.File{}, byBase: map[string][]db.File{}, roots: []string{"/w"}}
	for _, f := range []db.File{
		{ID: "promos", Path: "/w/src/promos.ts", RelPath: "src/promos.ts"},
		{ID: "adjust", Path: "/w/src/adjust.ts", RelPath: "src/adjust.ts"},
		{ID: "checkout", Path: "/w/src/checkout.ts", RelPath: "src/checkout.ts"},
	} {
		idx.byAbs[normAbs(f.Path)] = f
		idx.byRel[f.RelPath] = f
	}
	return idx
}

func mutation(path string, calls int, pairs ...string) runtime.Mutation {
	m := runtime.Mutation{Path: path, Calls: calls}
	for i := 0; i+1 < len(pairs); i += 2 {
		m.Examples = append(m.Examples, struct {
			Call   int    `json:"call"`
			Before string `json:"before"`
			After  string `json:"after"`
		}{i/2 + 1, pairs[i], pairs[i+1]})
	}
	return m
}

func shared(param string, calls int) []struct {
	Param     string `json:"param"`
	Calls     int    `json:"calls"`
	FirstCall int    `json:"firstCall"`
} {
	return []struct {
		Param     string `json:"param"`
		Calls     int    `json:"calls"`
		FirstCall int    `json:"firstCall"`
	}{{Param: param, Calls: calls, FirstCall: 1}}
}

func TestSharedMutationLeadsAndIsAttributedToTheInnermostFunction(t *testing.T) {
	out := &runtime.RunOutcome{
		Edges: []runtime.EvidenceEdge{{
			From:  runtime.EvidenceRef{File: "/w/src/adjust.ts", Name: "surchargesFor", Line: 5},
			To:    runtime.EvidenceRef{File: "/w/src/promos.ts", Name: "applyPeak", Line: 3},
			Calls: 48,
		}},
		Watched: []runtime.WatchedEvidence{
			{File: "/w/src/adjust.ts", Symbol: "surchargesFor", Line: 5, Calls: 48,
				Mutations: []runtime.Mutation{mutation("table.surcharges.peak", 32, "(absent)", "2.5", "2.5", "5")}},
			{File: "/w/src/promos.ts", Symbol: "applyPeak", Line: 3, Calls: 48,
				Mutations: []runtime.Mutation{mutation("table.surcharges.peak", 32, "(absent)", "2.5", "2.5", "5")},
				Shared:    shared("table", 46)},
		},
	}
	rep := analyzeRun(out, nil, testIndex())
	if len(rep.Findings) == 0 {
		t.Fatal("no findings")
	}
	top := rep.Findings[0]
	if top.Anchor.Symbol != "applyPeak" || top.Severity != "high" {
		t.Fatalf("the mutating function should lead, got %+v", top)
	}
	if !strings.Contains(top.Text, "receives the same `table` object again on 46 of 48 calls") {
		t.Fatalf("shared identity missing from the lead finding: %s", top.Text)
	}
	for _, f := range rep.Findings {
		if f.Anchor.Symbol == "surchargesFor" && f.Kind == "mutation" && f.Severity != "info" {
			t.Fatalf("the caller inherits the mutation; it must not be reported as the cause: %+v", f)
		}
	}
	if rep.Headline == "" || !strings.HasPrefix(rep.Headline, "applyPeak changes") {
		t.Fatalf("headline should state the lead finding, got %q", rep.Headline)
	}
}

func TestCollectionMutationsRollUpAndReceiverChangesAreNotSuspicious(t *testing.T) {
	out := &runtime.RunOutcome{Watched: []runtime.WatchedEvidence{{
		File: "/w/src/promos.ts", Symbol: "reserve", Line: 3, Calls: 6,
		Mutations: []runtime.Mutation{
			mutation("tags.length", 6, "0", "1", "1", "2"),
			mutation("tags[0]", 1, "(absent)", `"A"`),
			mutation("tags[1]", 1, "(absent)", `"B"`),
			mutation("self.count", 6, "0", "1"),
		},
		Shared: shared("tags", 5),
	}}}
	rep := analyzeRun(out, nil, testIndex())
	var high []string
	for _, f := range rep.Findings {
		if f.Severity == "high" {
			high = append(high, f.Text)
		}
	}
	if len(high) != 1 || !strings.Contains(high[0], "changes the size of its argument `tags`") {
		t.Fatalf("expected exactly one rolled-up finding for tags, got %q", high)
	}
	for _, f := range rep.Findings {
		if strings.Contains(f.Text, "self.count") && f.Severity != "info" {
			t.Fatalf("a method changing its own state is not a side effect: %+v", f)
		}
	}
}

func TestRepeatsExceptionsAndNotCalled(t *testing.T) {
	out := &runtime.RunOutcome{
		Functions: []runtime.EvidenceFunction{{File: "/w/lib/bundle.js", Name: "codespan", Line: 900, Calls: 12}},
		Watched: []runtime.WatchedEvidence{{
			File: "/w/src/checkout.ts", Symbol: "award", Line: 8, Calls: 96, Repeats: 48,
			Exceptions: []struct {
				What string `json:"what"`
				N    int    `json:"n"`
			}{{What: "TypeError: x is undefined", N: 2}},
		}},
	}
	requested := []runtime.RunWatch{
		{FileID: "checkout", RelPath: "src/checkout.ts", AbsPath: "/w/src/checkout.ts", Symbol: "award"},
		{FileID: "promos", RelPath: "src/promos.ts", AbsPath: "/w/src/promos.ts", Symbol: "codespan"},
	}
	rep := analyzeRun(out, requested, testIndex())
	text := ""
	for _, f := range rep.Findings {
		text += f.Kind + ": " + f.Text + "\n"
	}
	for _, want := range []string{
		"repeat: `award` ran again with exactly the same arguments as the call before on 48 of 96 calls",
		"exception: `award` threw `TypeError: x is undefined` on 2 of 96 calls",
		"not_called: `codespan` in src/promos.ts never ran, but a `codespan` in lib/bundle.js ran 12 times",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
}

func TestFailedTestsAcrossRunners(t *testing.T) {
	cases := map[string]struct {
		output string
		names  []string
		count  int
	}{
		"node spec": {"✔ ok one (1ms)\n✖ parser (3ms)\n  ✖ parser should pass (2ms)\nℹ fail 1\n", []string{"parser should pass"}, 1},
		"tap":       {"ok 1 - a\nnot ok 2 - rounds cents\n# fail 1\n", []string{"rounds cents"}, 1},
		"pytest":    {"FAILED tests/test_x.py::test_totals - AssertionError\n1 failed, 3 passed", []string{"tests/test_x.py::test_totals"}, 1},
		"jest":      {"  ✕ adds tax (5 ms)\nTests: 1 failed, 4 passed", []string{"adds tax"}, 1},
		"go":        {"--- FAIL: TestQuote (0.00s)\nFAIL", []string{"TestQuote"}, 1},
		"cargo":     {"test tests::rounding ... FAILED\n", []string{"tests::rounding"}, 1},
		"clean":     {"ok 1 - fine\n# fail 0\n", nil, 0},
	}
	for name, c := range cases {
		names, count := failedTests(c.output)
		if count != c.count || strings.Join(names, "|") != strings.Join(c.names, "|") {
			t.Errorf("%s: got %q (%d), want %q (%d)", name, names, count, c.names, c.count)
		}
	}
}

func TestRunReportIsBoundedAndSaysWhatToDoNext(t *testing.T) {
	long := strings.Repeat("line of program output\n", 5000)
	out := &runtime.RunOutcome{Command: "npm test", ExitCode: 0, Output: long, Instrumented: []string{"javascript"},
		Functions: []runtime.EvidenceFunction{{File: "/w/src/checkout.ts", Name: "checkout", Line: 1, Calls: 3}}}
	rep := analyzeRun(out, nil, testIndex())
	rep.N = 1
	text := renderRunReport(rep, 0)
	if len(text) > 8000 {
		t.Fatalf("report is %d bytes; a run must not flood the agent's context", len(text))
	}
	if !strings.Contains(text, "run again with watch:") {
		t.Fatal("an unwatched run should say how to get detail")
	}
	raw, _ := json.Marshal(rep)
	if len(raw) > 64*1024 {
		t.Fatalf("run event is %d bytes; it is broadcast and recorded", len(raw))
	}
}

func TestConfinedCwd(t *testing.T) {
	if _, err := confinedCwd("/w", "../etc"); err == nil {
		t.Fatal("a run must not leave the workspace")
	}
	if got, err := confinedCwd("/w", "packages/api"); err != nil || got != "/w/packages/api" {
		t.Fatalf("relative cwd: %q %v", got, err)
	}
	if got, _ := confinedCwd("/w", ""); got != "/w" {
		t.Fatalf("default cwd: %q", got)
	}
}
