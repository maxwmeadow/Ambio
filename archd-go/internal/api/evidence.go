// Evidence analysis: turn a finished run's raw recording into findings.
//
// The recorder captures a lot (every function's call count, every watched
// value path on every call). Most of it is noise for any given question. This
// file decides what an investigator should look at first, and says it once in
// plain words - the same finding feeds the agent's tool result and the
// canvas, so the human and the agent see the same evidence.
//
// Ranking, most to least suspicious:
//
//	crash       an uncaught exception, pinned to the first frame in user code
//	exception   a watched function threw
//	mutation    a watched function changed its argument - the side effect
//	            reading the code hides; attributed to the innermost function
//	accumulate  a value passed in grows or shrinks on every call: state is
//	            being carried between calls somewhere
//	not_called  a watched function never ran during the command
//	trend       a returned value moves steadily across calls
//	exit        the command failed or timed out
package api

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/runtime"
)

// ─── file index ───────────────────────────────────────────────────────────────

type fileIndex struct {
	workspaceID string
	byAbs       map[string]db.File
	byRel       map[string]db.File
	byBase      map[string][]db.File
	roots       []string
}

func normAbs(p string) string {
	p = filepath.ToSlash(filepath.Clean(p))
	if goruntime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

func (s *Server) loadFileIndex(sqlDB *sql.DB, workspaceID string) (*fileIndex, error) {
	files, err := db.GetFiles(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	idx := &fileIndex{workspaceID: workspaceID, byAbs: map[string]db.File{}, byRel: map[string]db.File{}, byBase: map[string][]db.File{}}
	for _, f := range files {
		idx.byAbs[normAbs(f.Path)] = f
		idx.byRel[filepath.ToSlash(f.RelPath)] = f
		base := strings.ToLower(filepath.Base(f.RelPath))
		idx.byBase[base] = append(idx.byBase[base], f)
	}
	if roots, err := db.GetActiveRoots(sqlDB, workspaceID); err == nil {
		for _, r := range roots {
			idx.roots = append(idx.roots, normAbs(r.Path))
		}
	}
	return idx, nil
}

func (idx *fileIndex) anchorFor(absPath, symbol string, line int) runtime.Anchor {
	a := runtime.Anchor{Symbol: symbol, Line: line}
	if f, ok := idx.byAbs[normAbs(absPath)]; ok {
		a.FileID = f.ID
		a.RelPath = f.RelPath
		return a
	}
	// Not an indexed file (ignored, generated, new since indexing). Still
	// show something readable: the path relative to the workspace.
	n := normAbs(absPath)
	for _, root := range idx.roots {
		if strings.HasPrefix(n, root+"/") {
			a.RelPath = strings.TrimPrefix(n, root+"/")
			return a
		}
	}
	a.RelPath = filepath.Base(absPath)
	return a
}

// ─── report types ─────────────────────────────────────────────────────────────

// Finding is one thing a run showed, worded for a person.
type Finding struct {
	Kind     string         `json:"kind"`
	Severity string         `json:"severity"` // high | medium | info
	Anchor   runtime.Anchor `json:"anchor"`
	Text     string         `json:"text"`
	Detail   string         `json:"detail,omitempty"`
	rank     int
}

type ReportFile struct {
	FileID    string `json:"fileId,omitempty"`
	RelPath   string `json:"relPath"`
	Calls     int64  `json:"calls"`
	Errors    int64  `json:"errors"`
	Functions int    `json:"functions"`
}

type ReportEdge struct {
	From  string `json:"from"` // file id
	To    string `json:"to"`
	Calls int64  `json:"calls"`
}

type ReportFunction struct {
	Anchor runtime.Anchor `json:"anchor"`
	Calls  int64          `json:"calls"`
	Errors int64          `json:"errors"`
}

type ReportWatched struct {
	Anchor   runtime.Anchor       `json:"anchor"`
	Calls    int64                `json:"calls"`
	Errors   int64                `json:"errors"`
	AvgMs    float64              `json:"avgMs"`
	Findings []Finding            `json:"findings"`
	Returns  string               `json:"returns,omitempty"`
	Samples  []runtime.CallSample `json:"samples"`
}

type ReportCrash struct {
	What   string         `json:"what"`
	Anchor runtime.Anchor `json:"anchor"`
	Stack  string         `json:"stack"`
}

// RunReport is what a run showed, ready for the agent and the canvas.
type RunReport struct {
	ID           string           `json:"id"`
	N            int              `json:"n"`
	Command      string           `json:"command"`
	Cwd          string           `json:"cwd"`
	ExitCode     int              `json:"exitCode"`
	TimedOut     bool             `json:"timedOut"`
	DurationMs   int64            `json:"durationMs"`
	HypothesisID string           `json:"hypothesisId,omitempty"`
	Headline     string           `json:"headline"`
	Findings     []Finding        `json:"findings"`
	Watched      []ReportWatched  `json:"watched"`
	NotCalled    []runtime.Anchor `json:"notCalled,omitempty"`
	Files        []ReportFile     `json:"files"`
	Edges        []ReportEdge     `json:"edges"`
	Hot          []ReportFunction `json:"hot"`
	FunctionsRun int              `json:"functionsRun"`
	FilesRun     int              `json:"filesRun"`
	Crashes      []ReportCrash    `json:"crashes,omitempty"`
	OutputTail   string           `json:"outputTail"`
	OutputLines  int              `json:"outputLines"`
	Instrumented []string         `json:"instrumented"`
	Processes    int              `json:"processes"`
}

// ─── analysis ─────────────────────────────────────────────────────────────────

func analyzeRun(out *runtime.RunOutcome, requested []runtime.RunWatch, idx *fileIndex) *RunReport {
	rep := &RunReport{
		ID:           out.ID,
		Command:      out.Command,
		Cwd:          out.Cwd,
		ExitCode:     out.ExitCode,
		TimedOut:     out.TimedOut,
		DurationMs:   out.DurationMs,
		Instrumented: out.Instrumented,
		Processes:    out.Processes,
	}

	// Files and functions that ran.
	type fileAgg struct {
		f         ReportFile
		functions int
	}
	byFile := map[string]*fileAgg{}
	fileKey := func(a runtime.Anchor) string {
		if a.FileID != "" {
			return a.FileID
		}
		return "path:" + a.RelPath
	}
	for _, fn := range out.Functions {
		a := idx.anchorFor(fn.File, fn.Name, fn.Line)
		k := fileKey(a)
		agg := byFile[k]
		if agg == nil {
			agg = &fileAgg{f: ReportFile{FileID: a.FileID, RelPath: a.RelPath}}
			byFile[k] = agg
		}
		agg.f.Calls += fn.Calls
		agg.f.Errors += fn.Errors
		agg.functions++
		rep.FunctionsRun++
		if len(rep.Hot) < 10 && fn.Name != "<anonymous>" {
			rep.Hot = append(rep.Hot, ReportFunction{Anchor: a, Calls: fn.Calls, Errors: fn.Errors})
		}
	}
	for _, agg := range byFile {
		agg.f.Functions = agg.functions
		rep.Files = append(rep.Files, agg.f)
	}
	sort.Slice(rep.Files, func(i, j int) bool { return rep.Files[i].Calls > rep.Files[j].Calls })
	rep.FilesRun = len(rep.Files)

	// File-level edges for the map (same-file calls are not an architecture edge).
	edgeAgg := map[[2]string]int64{}
	for _, e := range out.Edges {
		from := idx.anchorFor(e.From.File, e.From.Name, e.From.Line)
		to := idx.anchorFor(e.To.File, e.To.Name, e.To.Line)
		if from.FileID == "" || to.FileID == "" || from.FileID == to.FileID {
			continue
		}
		edgeAgg[[2]string{from.FileID, to.FileID}] += e.Calls
	}
	for k, n := range edgeAgg {
		rep.Edges = append(rep.Edges, ReportEdge{From: k[0], To: k[1], Calls: n})
	}
	sort.Slice(rep.Edges, func(i, j int) bool { return rep.Edges[i].Calls > rep.Edges[j].Calls })
	if len(rep.Edges) > 80 {
		rep.Edges = rep.Edges[:80]
	}

	// Which watched functions call which: a mutation seen in both a caller and
	// its callee happened in the callee.
	calls := map[string]map[string]bool{}
	fnID := func(file, name string) string { return normAbs(file) + "#" + name }
	for _, e := range out.Edges {
		from := fnID(e.From.File, e.From.Name)
		if calls[from] == nil {
			calls[from] = map[string]bool{}
		}
		calls[from][fnID(e.To.File, e.To.Name)] = true
	}
	mutationSig := func(m runtime.Mutation) string {
		parts := make([]string, 0, len(m.Examples))
		for _, ex := range m.Examples {
			parts = append(parts, ex.Before+">"+ex.After)
		}
		return stripRoot(m.Path) + "|" + strings.Join(parts, ",")
	}
	mutatedBy := map[string][]string{} // signature -> watched function ids
	for _, w := range out.Watched {
		for _, m := range w.Mutations {
			sig := mutationSig(m)
			mutatedBy[sig] = append(mutatedBy[sig], fnID(w.File, w.Symbol))
		}
	}

	seenWatch := map[string]bool{}
	for _, w := range out.Watched {
		a := idx.anchorFor(w.File, w.Symbol, w.Line)
		seenWatch[normAbs(w.File)+"#"+w.Symbol] = true
		rw := ReportWatched{Anchor: a, Calls: w.Calls, Errors: w.Errors, AvgMs: w.AvgMs}
		self := fnID(w.File, w.Symbol)
		name := "`" + w.Symbol + "`"

		sharedBy := map[string]int{} // param -> calls that got an object seen before
		for _, sh := range w.Shared {
			sharedBy[sh.Param] = sh.Calls
		}
		mutatedPaths := map[string]bool{}
		for _, m := range w.Mutations {
			mutatedPaths[stripRoot(m.Path)] = true
			inner := ""
			for _, other := range mutatedBy[mutationSig(m)] {
				if other != self && calls[self][other] {
					inner = other[strings.LastIndex(other, "#")+1:]
				}
			}
			examples := make([]string, 0, len(m.Examples))
			for _, ex := range m.Examples {
				examples = append(examples, ex.Before+" → "+ex.After)
			}
			more := ""
			if m.Calls > len(m.Examples) {
				more = " …"
			}
			f := Finding{Kind: "mutation", Anchor: a}
			if inner != "" {
				f.Severity = "info"
				f.rank = 40
				f.Text = fmt.Sprintf("%s's argument `%s` changes during the call, inside `%s`", name, m.Path, inner)
			} else {
				f.Severity = "high"
				f.rank = 90
				f.Text = fmt.Sprintf("%s changes its argument `%s` on %s: %s%s",
					name, m.Path, ofCalls(int64(m.Calls), w.Calls), strings.Join(examples, ", "), more)
				param := m.Path
				if i := strings.IndexAny(param, ".["); i >= 0 {
					param = param[:i]
				}
				if n := sharedBy[param]; n > 0 {
					// The whole explanation in one line: the function writes into
					// an object that is handed back to it next time.
					f.rank = 97
					f.Text += fmt.Sprintf(" - and it receives the same `%s` object again on %s, so each change carries into the next call",
						param, ofCalls(int64(n), w.Calls))
				}
			}
			rw.Findings = append(rw.Findings, f)
		}

		if w.Repeats >= 2 && float64(w.Repeats) >= 0.2*float64(w.Calls) {
			f := Finding{
				Kind: "repeat", Severity: "high", Anchor: a, rank: 92,
				Text: fmt.Sprintf("%s ran again with exactly the same arguments as the call before on %s - the same work is happening twice",
					name, ofCalls(int64(w.Repeats), w.Calls)),
			}
			if w.RepeatExample != nil {
				f.Detail = fmt.Sprintf("first at call %d: %s", w.RepeatExample.Call, clip(w.RepeatExample.Args, 200))
				f.Text += fmt.Sprintf(" (first repeat: call %d)", w.RepeatExample.Call)
			}
			rw.Findings = append(rw.Findings, f)
		}
		for _, ex := range w.Exceptions {
			rw.Findings = append(rw.Findings, Finding{
				Kind: "exception", Severity: "high", Anchor: a, rank: 95,
				Text: fmt.Sprintf("%s threw `%s` on %s", name, ex.What, ofCalls(int64(ex.N), w.Calls)),
			})
		}

		// Values that move steadily across calls.
		type trend struct {
			path string
			v    runtime.ValueStats
		}
		var trends []trend
		for p, v := range w.Values {
			if v.Kind != "number" || v.Count < 4 || v.Changes < 3 {
				continue
			}
			if v.Trend != "increasing" && v.Trend != "decreasing" {
				continue
			}
			if strings.Contains(p, "[") {
				continue // positional data (cart.lines[2]) varies by input, not state
			}
			trends = append(trends, trend{p, v})
		}
		sort.Slice(trends, func(i, j int) bool {
			if trends[i].v.Changes != trends[j].v.Changes {
				return trends[i].v.Changes > trends[j].v.Changes
			}
			return trends[i].path < trends[j].path
		})
		reported := map[string]bool{}
		for _, t := range trends {
			tail := stripRoot(strings.TrimPrefix(t.path, "arg."))
			if reported[tail] || len(reported) >= 3 {
				continue
			}
			reported[tail] = true
			arg := strings.HasPrefix(t.path, "arg.")
			if arg && mutatedPaths[tail] {
				continue // already explained by the mutation finding
			}
			seq := seriesText(t.v)
			f := Finding{Anchor: a}
			depth := strings.Count(strings.TrimPrefix(t.path, "arg."), ".") + 1
			if arg && depth > 3 {
				// A value deep inside a large argument (receipt.shipping.surcharges.peak)
				// is usually another component's state showing through, not this
				// function's problem. Worth mentioning, not leading with.
				f.Kind, f.Severity, f.rank = "accumulate", "medium", 55
				f.Text = fmt.Sprintf("`%s` passed into %s %s across calls: %s",
					strings.TrimPrefix(t.path, "arg."), name, t.v.Trend[:len(t.v.Trend)-3]+"es", seq)
			} else if arg {
				f.Kind, f.Severity, f.rank = "accumulate", "high", 80
				f.Text = fmt.Sprintf("`%s` passed into %s %s on every call: %s - something carries state between calls",
					strings.TrimPrefix(t.path, "arg."), name, t.v.Trend[:len(t.v.Trend)-3]+"es", seq)
			} else {
				f.Kind, f.Severity, f.rank = "trend", "medium", 50
				f.Text = fmt.Sprintf("%s's `%s` %s across calls: %s", name, t.path, t.v.Trend[:len(t.v.Trend)-3]+"es", seq)
			}
			rw.Findings = append(rw.Findings, f)
		}

		if w.Returns != nil {
			rw.Returns = returnsText(*w.Returns)
		}
		rw.Samples = pickSamples(w.Samples)
		rep.Watched = append(rep.Watched, rw)
		rep.Findings = append(rep.Findings, rw.Findings...)
	}

	// Watched functions that never ran are evidence too.
	for _, rq := range requested {
		key := normAbs(rq.AbsPath) + "#" + rq.Symbol
		if rq.Symbol == "*" || seenWatch[key] {
			continue
		}
		a := runtime.Anchor{FileID: rq.FileID, RelPath: rq.RelPath, Symbol: rq.Symbol, Line: rq.LineStart}
		rep.NotCalled = append(rep.NotCalled, a)
		rep.Findings = append(rep.Findings, Finding{
			Kind: "not_called", Severity: "medium", Anchor: a, rank: 60,
			Text: fmt.Sprintf("`%s` never ran during this command", rq.Symbol),
		})
	}

	for _, u := range out.Uncaught {
		a := firstUserFrame(u.Stack, idx)
		rep.Crashes = append(rep.Crashes, ReportCrash{What: u.What, Anchor: a, Stack: u.Stack})
		where := ""
		if a.RelPath != "" {
			where = " at " + a.RelPath
			if a.Line > 0 {
				where += ":" + strconv.Itoa(a.Line)
			}
		}
		rep.Findings = append(rep.Findings, Finding{
			Kind: "crash", Severity: "high", Anchor: a, rank: 100,
			Text: fmt.Sprintf("Uncaught `%s`%s", u.What, where),
		})
	}

	if out.TimedOut {
		rep.Findings = append(rep.Findings, Finding{Kind: "exit", Severity: "high", rank: 70,
			Text: fmt.Sprintf("Timed out after %s and was stopped", humanMs(out.DurationMs))})
	} else if out.ExitCode != 0 {
		rep.Findings = append(rep.Findings, Finding{Kind: "exit", Severity: "medium", rank: 45,
			Text: fmt.Sprintf("Exited with code %d", out.ExitCode)})
	}

	sort.SliceStable(rep.Findings, func(i, j int) bool { return rep.Findings[i].rank > rep.Findings[j].rank })

	lines := strings.Split(strings.TrimRight(out.Output, "\n"), "\n")
	if strings.TrimSpace(out.Output) == "" {
		lines = nil
	}
	rep.OutputLines = len(lines)
	tailN := 30
	if len(lines) > tailN {
		rep.OutputTail = strings.Join(lines[len(lines)-tailN:], "\n")
	} else {
		rep.OutputTail = strings.Join(lines, "\n")
	}

	switch {
	case len(rep.Findings) > 0 && rep.Findings[0].Severity == "high":
		rep.Headline = stripTicks(rep.Findings[0].Text)
	case out.TimedOut:
		rep.Headline = "Timed out"
	case out.ExitCode != 0:
		rep.Headline = fmt.Sprintf("Exited %d", out.ExitCode)
	default:
		rep.Headline = fmt.Sprintf("Ran %d functions in %d files", rep.FunctionsRun, rep.FilesRun)
	}
	return rep
}

func stripRoot(path string) string {
	if i := strings.IndexAny(path, ".["); i >= 0 {
		return path[i:]
	}
	return ""
}

func stripTicks(s string) string { return strings.ReplaceAll(s, "`", "") }

func ofCalls(n, total int64) string {
	if n >= total {
		return fmt.Sprintf("all %d calls", total)
	}
	return fmt.Sprintf("%d of %d calls", n, total)
}

func seriesText(v runtime.ValueStats) string {
	s := v.Series
	if len(s) > 6 {
		s = s[:6]
	}
	text := strings.Join(s, ", ")
	if v.Count > len(s) {
		text += " … " + v.Last
	}
	return text
}

func returnsText(v runtime.ValueStats) string {
	if v.Count == 0 {
		return ""
	}
	if v.Changes == 0 {
		return "always " + v.First
	}
	if strings.HasSuffix(string(v.Distinct), "+\"") {
		return "" // too varied to summarise; the samples show examples
	}
	if len(v.Top) > 0 && len(v.Top) <= 5 {
		parts := make([]string, 0, len(v.Top))
		for _, t := range v.Top {
			parts = append(parts, fmt.Sprintf("%s ×%d", t.Value, t.N))
		}
		return strings.Join(parts, ", ")
	}
	if v.Kind == "number" && v.Min != nil && v.Max != nil {
		return fmt.Sprintf("%s to %s (%s)", trimFloat(*v.Min), trimFloat(*v.Max), v.Trend)
	}
	return fmt.Sprintf("%s distinct values", strings.Trim(string(v.Distinct), `"`))
}

func trimFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// pickSamples keeps the first two and the last call, plus any that threw or
// mutated - the calls worth reading.
func pickSamples(all []runtime.CallSample) []runtime.CallSample {
	if len(all) <= 3 {
		return all
	}
	out := []runtime.CallSample{all[0], all[1]}
	for _, s := range all[2 : len(all)-1] {
		if (s.Threw != "" || len(s.Mutated) > 0) && len(out) < 4 {
			out = append(out, s)
		}
	}
	return append(out, all[len(all)-1])
}

var stackFrame = regexp.MustCompile(`\(?((?:file://)?(?:[A-Za-z]:)?[^\s():]+):(\d+):\d+\)?\s*$`)

func firstUserFrame(stack string, idx *fileIndex) runtime.Anchor {
	for _, line := range strings.Split(stack, "\n") {
		m := stackFrame.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		path := strings.TrimPrefix(m[1], "file://")
		if _, ok := idx.byAbs[normAbs(path)]; !ok {
			continue
		}
		n, _ := strconv.Atoi(m[2])
		fn := ""
		if t := strings.TrimSpace(line); strings.HasPrefix(t, "at ") {
			if fields := strings.Fields(t); len(fields) > 2 {
				fn = fields[1]
			}
		}
		return idx.anchorFor(path, fn, n)
	}
	return runtime.Anchor{}
}

func humanMs(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

// ─── agent-facing text ────────────────────────────────────────────────────────

func where(a runtime.Anchor) string {
	if a.RelPath == "" {
		return ""
	}
	if a.Line > 0 {
		return fmt.Sprintf("%s:%d", a.RelPath, a.Line)
	}
	return a.RelPath
}

// renderRunReport is the tool result an agent reads. It leads with what is
// suspicious, then the detail per watched function, then what ran, then the
// program's own output. Bounded so a big run cannot flood the context.
func renderRunReport(rep *RunReport, requestedWatches int) string {
	var b strings.Builder
	status := fmt.Sprintf("exit %d", rep.ExitCode)
	if rep.TimedOut {
		status = "timed out"
	}
	fmt.Fprintf(&b, "Run R%d · `%s` · %s · %s", rep.N, rep.Command, status, humanMs(rep.DurationMs))
	if rep.HypothesisID != "" {
		fmt.Fprintf(&b, " · testing %s", rep.HypothesisID)
	}
	b.WriteString("\n")

	if len(rep.Findings) > 0 {
		b.WriteString("\nFindings\n")
		shown := 0
		for _, f := range rep.Findings {
			if f.Severity == "info" || shown >= 8 {
				continue
			}
			mark := "•"
			if f.Severity == "high" {
				mark = "!"
			}
			fmt.Fprintf(&b, "%s %s", mark, f.Text)
			if w := where(f.Anchor); w != "" && !strings.Contains(f.Text, w) {
				fmt.Fprintf(&b, "  (%s)", w)
			}
			b.WriteString("\n")
			shown++
		}
	}

	if len(rep.Watched) > 0 {
		b.WriteString("\nWatched\n")
		for _, w := range rep.Watched {
			fmt.Fprintf(&b, "• %s  %s · %d calls", w.Anchor.Symbol, where(w.Anchor), w.Calls)
			if w.Errors > 0 {
				fmt.Fprintf(&b, " · %d threw", w.Errors)
			}
			if w.Returns != "" {
				fmt.Fprintf(&b, " · returns %s", clip(w.Returns, 120))
			}
			b.WriteString("\n")
			for _, f := range w.Findings {
				if f.Severity == "info" {
					fmt.Fprintf(&b, "    %s\n", f.Text)
				}
			}
			for _, s := range w.Samples {
				fmt.Fprintf(&b, "    call %d: %s", s.Call, clip(s.Args, 160))
				switch {
				case s.Threw != "":
					fmt.Fprintf(&b, " threw %s", clip(s.Threw, 120))
				case s.Returned != nil:
					fmt.Fprintf(&b, " → %s", clip(*s.Returned, 120))
				}
				if len(s.Mutated) > 0 {
					fmt.Fprintf(&b, "  [changed %s]", clip(strings.Join(s.Mutated, "; "), 120))
				}
				b.WriteString("\n")
			}
		}
	}

	if rep.FunctionsRun > 0 {
		fmt.Fprintf(&b, "\nExecuted %d functions in %d files", rep.FunctionsRun, rep.FilesRun)
		if len(rep.Hot) > 0 {
			parts := []string{}
			for _, h := range rep.Hot[:min(6, len(rep.Hot))] {
				parts = append(parts, fmt.Sprintf("%s ×%d", h.Anchor.Symbol, h.Calls))
			}
			b.WriteString(". Most called: " + strings.Join(parts, ", "))
		}
		b.WriteString("\n")
	} else {
		names := map[string]string{"javascript": "JavaScript/TypeScript", "python": "Python"}
		var shown []string
		for _, l := range rep.Instrumented {
			if n, ok := names[l]; ok {
				shown = append(shown, n)
			} else {
				shown = append(shown, l)
			}
		}
		langs := strings.Join(shown, " or ")
		if langs == "" {
			langs = "no language"
		}
		fmt.Fprintf(&b, "\nNo runtime evidence: the command ran no %s code from this workspace, so only its output is available.\n", langs)
	}

	if rep.OutputLines > 0 {
		shown := strings.Count(rep.OutputTail, "\n") + 1
		if shown < rep.OutputLines {
			fmt.Fprintf(&b, "\nOutput (last %d of %d lines)\n", shown, rep.OutputLines)
		} else {
			b.WriteString("\nOutput\n")
		}
		b.WriteString(clip(rep.OutputTail, 4000))
		b.WriteString("\n")
	}

	if rep.HypothesisID != "" {
		fmt.Fprintf(&b, "\nRecord what this showed: investigation verdict {hypothesis: %q, result: confirmed | refuted | inconclusive}.\n", rep.HypothesisID)
	}
	if requestedWatches == 0 && rep.FunctionsRun > 0 {
		b.WriteString("\nTo see arguments, return values and side effects, run again with watch: [\"path/to/file.ts:functionName\"] (or a whole file).\n")
	}
	return b.String()
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
