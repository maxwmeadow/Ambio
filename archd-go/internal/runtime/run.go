// Investigation runs: execute a command under observation and return what
// actually happened.
//
// This is the experiment primitive behind `investigation run`. It differs from
// LaunchTarget in three ways that matter for debugging:
//
//   - It is synchronous. The agent asked a question ("what does the code do
//     when I run the repro?") and the answer is the finished run.
//   - Watches go in through the environment, so they are active before the
//     first line of user code. Watches pushed over the adapter socket arrive
//     after connect and miss a short script entirely.
//   - The adapter aggregates in-process and writes a file per process at exit
//     (adapters/node/recorder.cjs), instead of streaming each call through a
//     rate limiter that a tight loop trips in milliseconds.
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	DefaultRunTimeout = 60 * time.Second
	MaxRunTimeout     = 10 * time.Minute
	runOutputHead     = 12 * 1024
	runOutputTail     = 48 * 1024
	killGrace         = 2 * time.Second
)

// RunWatch is one function (or, with Symbol "*", every function in a file)
// whose calls a run records in detail.
type RunWatch struct {
	FileID    string `json:"fileId"`
	RelPath   string `json:"relPath"`
	AbsPath   string `json:"absPath"`
	Symbol    string `json:"symbol"`
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
}

// RunSpec describes one experiment.
type RunSpec struct {
	WorkspaceID string
	Root        string // workspace root: what counts as "the user's code"
	Cwd         string
	Command     string
	Watches     []RunWatch
	Timeout     time.Duration
}

// EvidenceFunction is one instrumented function's aggregate for a run.
type EvidenceFunction struct {
	File   string  `json:"file"`
	Name   string  `json:"name"`
	Line   int     `json:"line"`
	Calls  int64   `json:"calls"`
	Errors int64   `json:"errors"`
	Ms     float64 `json:"ms"`
}

// EvidenceRef names a function in an edge.
type EvidenceRef struct {
	File string `json:"file"`
	Name string `json:"name"`
	Line int    `json:"line"`
}

// EvidenceEdge is a caller -> callee pair actually taken at runtime.
type EvidenceEdge struct {
	From  EvidenceRef `json:"from"`
	To    EvidenceRef `json:"to"`
	Calls int64       `json:"calls"`
}

// ValueStats summarises one value path (an argument field or the return value)
// across every call of a watched function.
type ValueStats struct {
	Kind     string          `json:"kind"`
	Count    int             `json:"count"`
	Changes  int             `json:"changes"`
	Distinct json.RawMessage `json:"distinct"`
	First    string          `json:"first"`
	Last     string          `json:"last"`
	Min      *float64        `json:"min,omitempty"`
	Max      *float64        `json:"max,omitempty"`
	Trend    string          `json:"trend"`
	Series   []string        `json:"series"`
	Tail     []string        `json:"tail,omitempty"`
	Top      []struct {
		Value string `json:"value"`
		N     int    `json:"n"`
	} `json:"top,omitempty"`
}

// Mutation is an argument path a watched function changed during its call.
type Mutation struct {
	Path     string `json:"path"`
	Calls    int    `json:"calls"`
	Examples []struct {
		Call   int    `json:"call"`
		Before string `json:"before"`
		After  string `json:"after"`
	} `json:"examples"`
}

// CallSample is one recorded call of a watched function.
type CallSample struct {
	Call     int      `json:"call"`
	Args     string   `json:"args"`
	Returned *string  `json:"returned,omitempty"`
	Threw    string   `json:"threw,omitempty"`
	Mutated  []string `json:"mutated,omitempty"`
	Ms       float64  `json:"ms"`
}

// WatchedEvidence is everything recorded about one watched function.
type WatchedEvidence struct {
	File       string                `json:"file"`
	Symbol     string                `json:"symbol"`
	Line       int                   `json:"line"`
	Calls      int64                 `json:"calls"`
	Errors     int64                 `json:"errors"`
	AvgMs      float64               `json:"avgMs"`
	Samples    []CallSample          `json:"samples"`
	Values     map[string]ValueStats `json:"values"`
	Mutations  []Mutation            `json:"mutations"`
	Exceptions []struct {
		What string `json:"what"`
		N    int    `json:"n"`
	} `json:"exceptions"`
	Returns *ValueStats `json:"returns,omitempty"`
	// Shared: parameters that received the same object on more than one call.
	Shared []struct {
		Param     string `json:"param"`
		Calls     int    `json:"calls"`
		FirstCall int    `json:"firstCall"`
	} `json:"shared,omitempty"`
	// Drift: an object reached from the arguments that is the same object on a
	// later call, with different contents - state shared between calls.
	Drift []struct {
		Path     string `json:"path"`
		Calls    int    `json:"calls"`
		Examples []struct {
			FromCall int `json:"fromCall"`
			ToCall   int `json:"toCall"`
			Changes  []struct {
				Key    string `json:"key"`
				Before string `json:"before"`
				After  string `json:"after"`
			} `json:"changes"`
		} `json:"examples"`
	} `json:"drift,omitempty"`
	Sampled int `json:"sampled"`
	// Repeats: calls whose arguments were identical to the previous call's.
	Repeats       int `json:"repeats"`
	RepeatExample *struct {
		Call int    `json:"call"`
		Args string `json:"args"`
	} `json:"repeatExample,omitempty"`
}

// UncaughtError is a crash seen by the recorder.
type UncaughtError struct {
	What  string `json:"what"`
	Stack string `json:"stack"`
}

// EvidenceDoc is one process's recorder output (see recorder.cjs write()).
type EvidenceDoc struct {
	Version      int                `json:"version"`
	PID          int                `json:"pid"`
	Argv         []string           `json:"argv"`
	StartedAt    int64              `json:"startedAt"`
	EndedAt      int64              `json:"endedAt"`
	Functions    []EvidenceFunction `json:"functions"`
	Edges        []EvidenceEdge     `json:"edges"`
	EdgesDropped int                `json:"edgesDropped"`
	Watched      []WatchedEvidence  `json:"watched"`
	Uncaught     []UncaughtError    `json:"uncaught"`
}

// RunOutcome is a finished run: the process result plus merged evidence.
type RunOutcome struct {
	ID              string             `json:"id"`
	Command         string             `json:"command"`
	Cwd             string             `json:"cwd"`
	StartedAt       int64              `json:"startedAt"`
	DurationMs      int64              `json:"durationMs"`
	ExitCode        int                `json:"exitCode"`
	TimedOut        bool               `json:"timedOut"`
	Output          string             `json:"output"`
	OutputBytes     int64              `json:"outputBytes"`
	OutputTruncated bool               `json:"outputTruncated"`
	Processes       int                `json:"processes"` // processes that ran workspace code
	Functions       []EvidenceFunction `json:"functions"`
	Edges           []EvidenceEdge     `json:"edges"`
	Watched         []WatchedEvidence  `json:"watched"`
	Uncaught        []UncaughtError    `json:"uncaught"`
	Instrumented    []string           `json:"instrumented"` // languages whose adapters were injected
}

// cappedOutput keeps the head and tail of a stream so a runaway log costs a
// bounded amount of memory while the start and the end - usually the useful
// parts - survive.
type cappedOutput struct {
	mu    sync.Mutex
	head  bytes.Buffer
	tail  []byte
	total int64
}

func (c *cappedOutput) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))
	rest := p
	if room := runOutputHead - c.head.Len(); room > 0 {
		n := min(room, len(rest))
		c.head.Write(rest[:n])
		rest = rest[n:]
	}
	if len(rest) > 0 {
		c.tail = append(c.tail, rest...)
		if len(c.tail) > runOutputTail {
			c.tail = c.tail[len(c.tail)-runOutputTail:]
		}
	}
	return len(p), nil
}

func (c *cappedOutput) String() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := int64(c.head.Len() + len(c.tail))
	if kept >= c.total {
		return c.head.String() + string(c.tail), false
	}
	omitted := c.total - kept
	return c.head.String() + fmt.Sprintf("\n… %d bytes omitted …\n", omitted) + string(c.tail), true
}

// RunExperiment executes spec.Command with every available runtime adapter
// injected, waits for it to finish (or time out), and returns the merged
// evidence. It never returns an error for a failing program - a crash or a
// non-zero exit is evidence. Errors mean the run could not happen at all.
func (m *Manager) RunExperiment(ctx context.Context, spec RunSpec) (*RunOutcome, error) {
	if strings.TrimSpace(spec.Command) == "" {
		return nil, fmt.Errorf("command is required")
	}
	if spec.Timeout <= 0 {
		spec.Timeout = DefaultRunTimeout
	}
	if spec.Timeout > MaxRunTimeout {
		spec.Timeout = MaxRunTimeout
	}
	if spec.Cwd == "" {
		spec.Cwd = spec.Root
	}

	runID := uuid.New().String()[:8]
	evidenceDir, err := os.MkdirTemp("", "axiom-run-"+runID+"-")
	if err != nil {
		return nil, fmt.Errorf("create evidence dir: %w", err)
	}
	defer os.RemoveAll(evidenceDir)

	watchJSON, _ := json.Marshal(spec.Watches)
	env := append(withUserPath(os.Environ()),
		"AXIOM_EVIDENCE_DIR="+evidenceDir,
		"AXIOM_RUN_ID="+runID,
		"AXIOM_WATCHES="+string(watchJSON),
	)
	var instrumented []string
	if dir, err := FindNodeAdapterDir(); err == nil {
		env = injectNodeEnv(env, dir, m.port, spec.WorkspaceID, spec.Root)
		instrumented = append(instrumented, "javascript")
	}
	if dir, err := FindPythonAdapterDir(); err == nil && pythonAdapterRecords(dir) {
		env = injectAdapterEnv(env, dir, m.port, spec.WorkspaceID)
		env = append(env, "AXIOM_WORKSPACE_ROOT="+spec.Root)
		instrumented = append(instrumented, "python")
	}

	runCtx, cancel := context.WithTimeout(ctx, spec.Timeout)
	defer cancel()

	cmd := shellCommand(spec.Command)
	cmd.Dir = spec.Cwd
	cmd.Env = env
	cmd.Stdin = nil // a run is non-interactive; a prompt must not hang it
	out := &cappedOutput{}
	cmd.Stdout = out
	cmd.Stderr = out
	prepareProcessGroup(cmd)

	started := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %q: %w", spec.Command, err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var waitErr error
	timedOut := false
	select {
	case waitErr = <-done:
	case <-runCtx.Done():
		timedOut = ctx.Err() == nil // our deadline, not a caller cancel
		killProcessGroup(cmd, false)
		select {
		case waitErr = <-done:
		case <-time.After(killGrace):
			killProcessGroup(cmd, true)
			waitErr = <-done
		}
	}
	duration := time.Since(started)

	exitCode := 0
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	if timedOut && exitCode == 0 {
		exitCode = -1
	}

	text, truncated := out.String()
	outcome := &RunOutcome{
		ID:              runID,
		Command:         spec.Command,
		Cwd:             spec.Cwd,
		StartedAt:       started.UnixMilli(),
		DurationMs:      duration.Milliseconds(),
		ExitCode:        exitCode,
		TimedOut:        timedOut,
		Output:          text,
		OutputBytes:     out.total,
		OutputTruncated: truncated,
		Instrumented:    instrumented,
	}
	mergeEvidence(outcome, readEvidence(evidenceDir))
	return outcome, nil
}

func readEvidence(dir string) []EvidenceDoc {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var docs []EvidenceDoc
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var doc EvidenceDoc
		if json.Unmarshal(raw, &doc) == nil {
			docs = append(docs, doc)
		}
	}
	return docs
}

func mergeEvidence(out *RunOutcome, docs []EvidenceDoc) {
	type fkey struct {
		file, name string
		line       int
	}
	type ekey struct{ from, to fkey }
	fns := map[fkey]*EvidenceFunction{}
	edges := map[ekey]*EvidenceEdge{}
	for _, doc := range docs {
		if len(doc.Functions) > 0 {
			out.Processes++
		}
		for _, f := range doc.Functions {
			k := fkey{f.File, f.Name, f.Line}
			if have, ok := fns[k]; ok {
				have.Calls += f.Calls
				have.Errors += f.Errors
				have.Ms += f.Ms
			} else {
				copy := f
				fns[k] = &copy
			}
		}
		for _, e := range doc.Edges {
			k := ekey{fkey{e.From.File, e.From.Name, e.From.Line}, fkey{e.To.File, e.To.Name, e.To.Line}}
			if have, ok := edges[k]; ok {
				have.Calls += e.Calls
			} else {
				copy := e
				edges[k] = &copy
			}
		}
		out.Watched = append(out.Watched, doc.Watched...)
		out.Uncaught = append(out.Uncaught, doc.Uncaught...)
	}
	for _, f := range fns {
		out.Functions = append(out.Functions, *f)
	}
	sort.Slice(out.Functions, func(i, j int) bool {
		if out.Functions[i].Calls != out.Functions[j].Calls {
			return out.Functions[i].Calls > out.Functions[j].Calls
		}
		return out.Functions[i].File+out.Functions[i].Name < out.Functions[j].File+out.Functions[j].Name
	})
	for _, e := range edges {
		out.Edges = append(out.Edges, *e)
	}
	sort.Slice(out.Edges, func(i, j int) bool { return out.Edges[i].Calls > out.Edges[j].Calls })
}

// shellCommand runs a command line the way the user would type it, so
// `npm test -- --grep x` and pipes behave as in their terminal.
func shellCommand(line string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/C", line)
	}
	shell := os.Getenv("SHELL")
	if shell == "" || strings.Contains(shell, "fish") {
		shell = "/bin/sh"
	}
	return exec.Command(shell, "-c", line)
}

// pythonAdapterRecords reports whether the Python adapter supports run
// recording. Until it does, injecting it would connect a live session that
// records nothing for the run.
func pythonAdapterRecords(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "axiom_adapter", "recorder.py"))
	return err == nil
}
