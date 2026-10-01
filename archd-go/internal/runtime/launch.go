// Target process launching. The agent (via MCP) or the UI asks archd to start
// the user's application with the language adapter pre-loaded through
// environment injection - zero changes to the user's codebase.
//
// For Python: the adapter directory (containing sitecustomize.py and the
// axiom_adapter package) is prepended to PYTHONPATH. CPython's site module
// imports sitecustomize automatically on interpreter startup, which connects
// the adapter back to this manager using AXIOM_RUNTIME_PORT / AXIOM_WORKSPACE_ID.
package runtime

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	targetLogTail    = 200 // lines of output retained per target
	maxExitedTargets = 20  // exited targets retained before pruning oldest
	maxTargetLineLen = 16 * 1024
)

// Target is a process launched (and owned) by archd.
type Target struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Command     []string `json:"command"`
	Cwd         string   `json:"cwd"`
	PID         int      `json:"pid"`
	StartedAt   int64    `json:"startedAt"`
	Status      string   `json:"status"` // 'running'|'exited'
	ExitCode    *int     `json:"exitCode,omitempty"`

	cmd     *exec.Cmd
	logMu   sync.Mutex
	logTail []string
}

// snapshotLocked returns a marshal-safe copy of the target's mutable state.
// Caller must hold m.mu (Status/ExitCode are mutated under it).
func (t *Target) snapshotLocked() map[string]any {
	return map[string]any{
		"id":          t.ID,
		"workspaceId": t.WorkspaceID,
		"command":     append([]string(nil), t.Command...),
		"cwd":         t.Cwd,
		"pid":         t.PID,
		"startedAt":   t.StartedAt,
		"status":      t.Status,
		"exitCode":    t.ExitCode,
	}
}

// LaunchTarget starts command in cwd with the runtime adapter for `language`
// injected via environment (zero code changes to the target). language is
// "python" or "javascript". Returns a marshal-safe snapshot of the target.
func (m *Manager) LaunchTarget(workspaceID string, command []string, cwd, language string) (map[string]any, error) {
	if len(command) == 0 {
		return nil, fmt.Errorf("command is required")
	}
	if cwd == "" {
		cwd = "."
	}
	if language == "" {
		language = "python"
	}

	var env []string
	switch language {
	case "javascript", "node":
		adapterDir, err := FindNodeAdapterDir()
		if err != nil {
			return nil, err
		}
		env = injectNodeEnv(os.Environ(), adapterDir, m.port, workspaceID, cwd)
	default:
		adapterDir, err := FindPythonAdapterDir()
		if err != nil {
			return nil, err
		}
		env = injectAdapterEnv(os.Environ(), adapterDir, m.port, workspaceID)
	}

	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = cwd
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %q: %w", strings.Join(command, " "), err)
	}

	t := &Target{
		ID:          uuid.New().String(),
		WorkspaceID: workspaceID,
		Command:     command,
		Cwd:         cwd,
		PID:         cmd.Process.Pid,
		StartedAt:   time.Now().UnixMilli(),
		Status:      "running",
		cmd:         cmd,
	}
	m.mu.Lock()
	m.targets[t.ID] = t
	dto := t.snapshotLocked()
	m.mu.Unlock()

	go m.pumpTargetOutput(t, stdout, "stdout")
	go m.pumpTargetOutput(t, stderr, "stderr")
	go func() {
		err := cmd.Wait()
		code := 0
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else if err != nil {
			code = -1
		}
		m.mu.Lock()
		t.Status = "exited"
		t.ExitCode = &code
		m.pruneExitedTargetsLocked()
		m.mu.Unlock()
		m.hub.Broadcast("runtime:target_exit", map[string]any{
			"workspaceId": workspaceID,
			"targetId":    t.ID,
			"exitCode":    code,
		})
		log.Printf("runtime: target %s exited with code %d", t.ID, code)
	}()

	m.hub.Broadcast("runtime:target_start", map[string]any{
		"workspaceId": workspaceID,
		"target":      dto,
	})
	log.Printf("runtime: launched target %s: %s (pid %d)", t.ID, strings.Join(command, " "), t.PID)
	return dto, nil
}

// pruneExitedTargetsLocked keeps only the newest maxExitedTargets exited
// targets so repeated launches don't grow m.targets forever. Caller holds m.mu.
func (m *Manager) pruneExitedTargetsLocked() {
	exited := make([]*Target, 0)
	for _, t := range m.targets {
		if t.Status == "exited" {
			exited = append(exited, t)
		}
	}
	for len(exited) > maxExitedTargets {
		oldest := 0
		for i, t := range exited {
			if t.StartedAt < exited[oldest].StartedAt {
				oldest = i
			}
		}
		delete(m.targets, exited[oldest].ID)
		exited = append(exited[:oldest], exited[oldest+1:]...)
	}
}

// pumpTargetOutput forwards child output line-by-line. Lines longer than
// maxTargetLineLen are truncated but the pipe keeps draining - abandoning the
// read (bufio.Scanner's ErrTooLong behavior) would block the child on a full
// pipe forever.
func (m *Manager) pumpTargetOutput(t *Target, r io.Reader, stream string) {
	reader := bufio.NewReaderSize(r, 32*1024)
	for {
		line, err := readLineCapped(reader, maxTargetLineLen)
		if len(line) > 0 {
			m.recordTargetLine(t, stream, line)
		}
		if err != nil {
			return
		}
	}
}

// readLineCapped reads one line, truncating anything beyond cap while still
// consuming the remainder so the pipe never backs up.
func readLineCapped(r *bufio.Reader, capLen int) (string, error) {
	var buf []byte
	truncated := false
	for {
		chunk, isPrefix, err := r.ReadLine()
		if len(chunk) > 0 && !truncated {
			remaining := capLen - len(buf)
			if len(chunk) > remaining {
				chunk = chunk[:remaining]
				truncated = true
			}
			buf = append(buf, chunk...)
		}
		if err != nil {
			return string(buf), err
		}
		if !isPrefix {
			if truncated {
				buf = append(buf, []byte(" …[truncated]")...)
			}
			return string(buf), nil
		}
	}
}

func (m *Manager) recordTargetLine(t *Target, stream, line string) {
	t.logMu.Lock()
	t.logTail = append(t.logTail, line)
	if len(t.logTail) > targetLogTail {
		t.logTail = t.logTail[len(t.logTail)-targetLogTail:]
	}
	t.logMu.Unlock()
	m.hub.Broadcast("runtime:target_log", map[string]any{
		"workspaceId": t.WorkspaceID,
		"targetId":    t.ID,
		"stream":      stream,
		"line":        line,
	})
}

// StopTarget kills a launched target process.
func (m *Manager) StopTarget(targetID string) (map[string]any, error) {
	m.mu.Lock()
	t, ok := m.targets[targetID]
	var dto map[string]any
	var running bool
	if ok {
		running = t.Status == "running"
		dto = t.snapshotLocked()
	}
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("target %s not found", targetID)
	}
	if running && t.cmd.Process != nil {
		if err := t.cmd.Process.Kill(); err != nil {
			return nil, fmt.Errorf("kill target %s: %w", targetID, err)
		}
	}
	return dto, nil
}

// TargetLog returns the retained output tail for a target.
func (m *Manager) TargetLog(targetID string) ([]string, error) {
	m.mu.RLock()
	t, ok := m.targets[targetID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("target %s not found", targetID)
	}
	t.logMu.Lock()
	defer t.logMu.Unlock()
	return append([]string{}, t.logTail...), nil
}

// injectAdapterEnv returns env with the Python adapter wired in. Existing
// PYTHONPATH entries are preserved (appended after the adapter dir).
func injectAdapterEnv(env []string, adapterDir string, port int, workspaceID string) []string {
	out := make([]string, 0, len(env)+3)
	pythonPath := adapterDir
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "PYTHONPATH=") {
			if v := kv[len("PYTHONPATH="):]; v != "" {
				pythonPath += string(os.PathListSeparator) + v
			}
			continue
		}
		out = append(out, kv)
	}
	out = append(out,
		"PYTHONPATH="+pythonPath,
		fmt.Sprintf("AXIOM_RUNTIME_PORT=%d", port),
		"AXIOM_WORKSPACE_ID="+workspaceID,
		// Without this, Python block-buffers stdout into a pipe and the live
		// target log stays empty until 8KB accumulates.
		"PYTHONUNBUFFERED=1",
	)
	return out
}

// FindRubyAdapterDir locates adapters/ruby (the run recorder).
func FindRubyAdapterDir() (string, error) {
	return findAdapterDir("ruby", "axiom_recorder.rb")
}

// injectRubyEnv loads the Ruby recorder into every Ruby the run starts. The
// directory goes on RUBYLIB (a path list, so spaces are fine) and RUBYOPT
// names only the feature: a path inside RUBYOPT is split on spaces, which
// breaks under C:\Program Files. Existing values are kept, and Bundler keeps
// both when it re-execs, so `bundle exec` records too.
func injectRubyEnv(env []string, adapterDir string) []string {
	out := make([]string, 0, len(env)+2)
	rubyLib := adapterDir
	rubyOpt := "-raxiom_recorder"
	for _, kv := range env {
		upper := strings.ToUpper(kv)
		switch {
		case strings.HasPrefix(upper, "RUBYLIB="):
			if v := kv[len("RUBYLIB="):]; v != "" {
				rubyLib += string(os.PathListSeparator) + v
			}
			continue
		case strings.HasPrefix(upper, "RUBYOPT="):
			if v := kv[len("RUBYOPT="):]; v != "" {
				rubyOpt += " " + v
			}
			continue
		}
		out = append(out, kv)
	}
	return append(out, "RUBYLIB="+rubyLib, "RUBYOPT="+rubyOpt)
}

// FindPHPAdapterDir locates the PHP run recorder (adapters/php).
func FindPHPAdapterDir() (string, error) {
	return findAdapterDir("php", phpRecorder)
}

const phpRecorder = "axiom_recorder.php"

// injectPHPEnv makes every PHP the run starts load the recorder first. PHP
// reads extra ini files from the folders in PHP_INI_SCAN_DIR, so the run gets
// an ini of its own (in iniDir) whose auto_prepend_file is the recorder. A
// leading separator keeps PHP's built-in scan folder, and so the user's own
// configuration, in effect; a value the user set is kept in front.
func injectPHPEnv(env []string, adapterDir, iniDir string) ([]string, error) {
	if err := os.MkdirAll(iniDir, 0o755); err != nil {
		return nil, err
	}
	// Forward slashes: a backslash before the closing quote would escape it.
	recorder := filepath.ToSlash(filepath.Join(adapterDir, phpRecorder))
	ini := "; Written by Axiom for one investigation run.\nauto_prepend_file=\"" + recorder + "\"\n"
	if err := os.WriteFile(filepath.Join(iniDir, "axiom.ini"), []byte(ini), 0o644); err != nil {
		return nil, err
	}
	scan := string(os.PathListSeparator) + iniDir
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "PHP_INI_SCAN_DIR=") {
			if v := kv[len("PHP_INI_SCAN_DIR="):]; v != "" {
				scan = v + string(os.PathListSeparator) + iniDir
			}
			continue
		}
		out = append(out, kv)
	}
	return append(out, "PHP_INI_SCAN_DIR="+scan), nil
}

// FindDotnetTargets locates the C# build hook (adapters/dotnet/Axiom.targets),
// which sits beside the rewriter it runs.
func FindDotnetTargets() (string, error) {
	dir, err := findAdapterDir("dotnet", dotnetTargets)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(dir, "AxiomRewriter.dll")); err != nil {
		return "", err
	}
	return filepath.Join(dir, dotnetTargets), nil
}

const (
	dotnetTargets    = "Axiom.targets"
	dotnetTargetsEnv = "CustomAfterMicrosoftCommonTargets"
)

// injectDotnetEnv makes every C# project the run builds import Axiom.targets.
// MSBuild turns environment variables into properties, and this one names a
// file the common targets import last; the targets then compile instrumented
// copies of the project's sources (adapters/dotnet). A value the user already
// set is theirs: the run then records no C#, and the note says why.
//
// The build servers are switched off for the run so that nothing it starts
// outlives it holding the run's environment.
func injectDotnetEnv(env []string, targets string) ([]string, string) {
	out := make([]string, 0, len(env)+4)
	for _, kv := range env {
		upper := strings.ToUpper(kv)
		switch {
		case strings.HasPrefix(upper, strings.ToUpper(dotnetTargetsEnv)+"="):
			if kv[len(dotnetTargetsEnv)+1:] != "" {
				return nil, "C# was not recorded: " + dotnetTargetsEnv + " is already set in the environment"
			}
			continue
		case strings.HasPrefix(upper, "MSBUILDDISABLENODEREUSE="), strings.HasPrefix(upper, "USESHAREDCOMPILATION="),
			strings.HasPrefix(upper, "DOTNET_CLI_USE_MSBUILD_SERVER="):
			continue
		}
		out = append(out, kv)
	}
	return append(out,
		dotnetTargetsEnv+"="+targets,
		"MSBUILDDISABLENODEREUSE=1",
		"UseSharedCompilation=false",
		"DOTNET_CLI_USE_MSBUILD_SERVER=0",
	), ""
}

// FindJavaAgentJar locates the JVM recorder (adapters/java/axiom-agent.jar).
func FindJavaAgentJar() (string, error) {
	dir, err := findAdapterDir("java", javaAgentJar)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, javaAgentJar), nil
}

const javaAgentJar = "axiom-agent.jar"

// injectJavaEnv loads the recorder into every JVM the run starts - java
// itself, Maven's Surefire forks, Gradle's test workers - through
// JAVA_TOOL_OPTIONS, which all of them read. The JVM splits the variable on
// spaces but honours quotes, so a path under C:\Program Files is quoted.
// The user's own options are kept.
func injectJavaEnv(env []string, agentJar string) []string {
	option := "-javaagent:" + agentJar
	if strings.ContainsAny(agentJar, " \t") {
		option = `-javaagent:"` + agentJar + `"`
	}
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "JAVA_TOOL_OPTIONS=") {
			if v := kv[len("JAVA_TOOL_OPTIONS="):]; v != "" {
				option += " " + v
			}
			continue
		}
		out = append(out, kv)
	}
	return append(out, "JAVA_TOOL_OPTIONS="+option)
}

// The JVM announces JAVA_TOOL_OPTIONS on stderr in every process it starts.
// That line is Axiom's doing, not the program's output.
func stripJavaToolOptionsNotice(output string) string {
	if !strings.Contains(output, javaToolOptionsNotice) {
		return output
	}
	lines := strings.SplitAfter(output, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if !strings.HasPrefix(line, javaToolOptionsNotice) {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "")
}

const javaToolOptionsNotice = "Picked up JAVA_TOOL_OPTIONS:"

// injectNodeEnv wires the Node adapter in via NODE_OPTIONS (--require for CJS,
// --import for ESM), preserving any existing NODE_OPTIONS. AXIOM_WORKSPACE_ROOT
// scopes instrumentation to the user's files (node_modules is skipped).
func injectNodeEnv(env []string, adapterDir string, port int, workspaceID, workspaceRoot string) []string {
	cjs := filepath.Join(adapterDir, "cjs-bootstrap.cjs")
	// --import needs a file: URL; --require takes a path.
	axiomOpts := "--require " + nodeOptionQuote(cjs) + " --import " + nodeOptionQuote(fileURL(filepath.Join(adapterDir, "esm-bootstrap.mjs")))

	out := make([]string, 0, len(env)+4)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "NODE_OPTIONS=") {
			if v := kv[len("NODE_OPTIONS="):]; v != "" {
				axiomOpts = v + " " + axiomOpts
			}
			continue
		}
		out = append(out, kv)
	}
	out = append(out,
		"NODE_OPTIONS="+axiomOpts,
		fmt.Sprintf("AXIOM_RUNTIME_PORT=%d", port),
		"AXIOM_WORKSPACE_ID="+workspaceID,
		"AXIOM_WORKSPACE_ROOT="+workspaceRoot,
	)
	return out
}

// nodeOptionQuote quotes a value for NODE_OPTIONS. Node's parser treats a
// backslash inside quotes as an escape, so Windows paths are passed with
// forward slashes (which Node accepts); Go's %q would also mangle non-ASCII
// characters in a user's home directory into \u escapes Node does not read.
func nodeOptionQuote(v string) string {
	v = strings.ReplaceAll(v, `\`, "/")
	return `"` + strings.ReplaceAll(v, `"`, `\"`) + `"`
}

// fileURL builds a file: URL for an absolute path on any OS. Formatting it by
// hand produced file:////Users/... on macOS and Linux (the path already starts
// with a slash) and left spaces unescaped, which NODE_OPTIONS splits on.
func fileURL(abs string) string {
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/x -> /C:/x
	}
	return (&url.URL{Scheme: "file", Path: p}).String()
}

// FindNodeAdapterDir locates the bundled Node adapter (marker: cjs-bootstrap.cjs).
func FindNodeAdapterDir() (string, error) {
	return findAdapterDir("node", "cjs-bootstrap.cjs")
}

// findAdapterDir searches standard locations for adapters/<sub>/<marker>.
func findAdapterDir(sub, marker string) (string, error) {
	var candidates []string
	if envDir := os.Getenv("AXIOM_ADAPTERS_DIR"); envDir != "" {
		candidates = append(candidates, filepath.Join(envDir, sub))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			// A checkout has both: out/adapters is the built, self-contained
			// adapter; adapters/ is its source, whose Node dependencies are
			// only bundled at build time.
			candidates = append(candidates,
				filepath.Join(dir, "out", "adapters", sub),
				filepath.Join(dir, "adapters", sub))
			dir = filepath.Dir(dir)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "out", "adapters", sub),
			filepath.Join(cwd, "adapters", sub))
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, marker)); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("%s adapter not found (searched %s); set AXIOM_ADAPTERS_DIR", sub, strings.Join(candidates, ", "))
}

// FindPythonAdapterDir locates the bundled Python adapter. Search order:
//  1. AXIOM_ADAPTERS_DIR env var (expects <dir>/python)
//  2. adapters/python next to the archd executable (packaged layout)
//  3. walking up from the executable to a repo root containing adapters/python (dev layout)
func FindPythonAdapterDir() (string, error) {
	var candidates []string
	if envDir := os.Getenv("AXIOM_ADAPTERS_DIR"); envDir != "" {
		candidates = append(candidates, filepath.Join(envDir, "python"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			candidates = append(candidates, filepath.Join(dir, "adapters", "python"))
			dir = filepath.Dir(dir)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "adapters", "python"))
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, "sitecustomize.py")); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("python adapter not found (searched %s); set AXIOM_ADAPTERS_DIR", strings.Join(candidates, ", "))
}
