package rustrecorder

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// WrapperEnv marks a process started by Cargo as the workspace wrapper during
// a run: archd then acts as the wrapper instead of starting the daemon.
const WrapperEnv = "AXIOM_RUSTC_WRAPPER"

const (
	maxAttempts = 6
	maxFiles    = 20000
	debugEnv    = "AXIOM_RECORDER_DEBUG"
)

// RunWrapper is `archd <rustc> <args...>` as Cargo invokes a wrapper. It
// returns the exit code. Whatever goes wrong, the crate is compiled exactly
// as Cargo asked: instrumentation is only ever an attempt made first.
func RunWrapper(argv []string) int {
	if len(argv) == 0 {
		return 1
	}
	job := plan(argv)
	if job == nil {
		return run(argv, nil)
	}
	tiers := map[string]map[int]int{}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		funcs, err := job.sync(tiers)
		if err != nil {
			debugf("%s: %v", job.crate, err)
			break
		}
		var stderr bytes.Buffer
		code := run(job.args(), &stderr)
		if code == 0 {
			os.Stderr.Write(stderr.Bytes())
			job.fixDepInfo()
			return 0
		}
		// Which functions' rewrites did the compiler reject? Drop each one
		// a tier and try again. An error that is in no rewritten function
		// is the user's own: compile their code and let rustc report it.
		if !demote(stderr.Bytes(), job, funcs, tiers) {
			debugf("%s: not recording (the instrumented crate did not compile)", job.crate)
			break
		}
	}
	return run(argv, nil)
}

func debugf(format string, args ...any) {
	if os.Getenv(debugEnv) != "" {
		fmt.Fprintf(os.Stderr, "[axiom] "+format+"\n", args...)
	}
}

func run(argv []string, stderr *bytes.Buffer) int {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if stderr != nil {
		cmd.Stderr = stderr
	}
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// job is one crate to compile from an instrumented copy of its sources.
type job struct {
	argv     []string
	srcIndex int    // which argument is the crate's root file
	srcArg   string // as Cargo gave it, usually relative
	srcDir   string // absolute folder of the root file: the tree that is mirrored
	mirror   string // where the instrumented copy lives
	crate    string
	unique   string // crate name and Cargo's build hash: a library and a binary may share a name
	edition  string
	depInfo  string
	cwd      string
}

// plan decides whether this invocation compiles a crate worth recording.
func plan(argv []string) *job {
	if os.Getenv("AXIOM_EVIDENCE_DIR") == "" {
		return nil
	}
	j := &job{argv: argv, srcIndex: -1}
	var outDir, extra, edition string
	for i := 1; i < len(argv); i++ {
		arg := argv[i]
		value := func() string {
			if i+1 < len(argv) {
				return argv[i+1]
			}
			return ""
		}
		switch {
		case arg == "--crate-name":
			j.crate = value()
			i++
		case arg == "--crate-type":
			if value() == "proc-macro" {
				return nil // runs inside the compiler, not the program
			}
			i++
		case arg == "--out-dir":
			outDir = value()
			i++
		case strings.HasPrefix(arg, "--edition="):
			edition = strings.TrimPrefix(arg, "--edition=")
		case arg == "-C" && strings.HasPrefix(value(), "extra-filename="):
			extra = strings.TrimPrefix(value(), "extra-filename=")
			i++
		case arg == "-C", arg == "-L", arg == "--cfg", arg == "--check-cfg", arg == "--extern", arg == "--cap-lints", arg == "--target", arg == "-o":
			i++
		case strings.HasSuffix(arg, ".rs") && !strings.HasPrefix(arg, "-") && j.srcIndex < 0:
			j.srcIndex = i
			j.srcArg = arg
		}
	}
	// `crate::` paths, which the added code uses, arrived with the 2018 edition.
	if j.srcIndex < 0 || j.crate == "" || outDir == "" || edition == "" || edition == "2015" || strings.HasPrefix(j.crate, "build_script_") {
		return nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	j.cwd = cwd
	srcAbs := j.srcArg
	if !filepath.IsAbs(srcAbs) {
		srcAbs = filepath.Join(cwd, srcAbs)
	}
	if real, err := filepath.EvalSymlinks(srcAbs); err == nil {
		srcAbs = real
	}
	root := os.Getenv("AXIOM_WORKSPACE_ROOT")
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	if root == "" || !strings.HasPrefix(srcAbs, root+string(filepath.Separator)) {
		return nil
	}
	head, err := os.ReadFile(srcAbs)
	if err != nil || bytes.Contains(head, []byte("#![no_std]")) {
		return nil // the recorder needs the standard library
	}
	j.srcDir = filepath.Dir(srcAbs)
	j.unique = j.crate + extra
	j.edition = edition
	j.mirror = filepath.Join(filepath.Dir(outDir), "axiom-src", j.unique)
	j.depInfo = filepath.Join(outDir, j.crate+extra+".d")
	return j
}

// args is the compiler command for the instrumented copy. Paths are remapped
// back, so diagnostics, panic locations and debug info name the user's files
// as an ordinary build would.
func (j *job) args() []string {
	out := append([]string{}, j.argv...)
	out[j.srcIndex] = filepath.Join(j.mirror, filepath.Base(j.srcArg))
	return append(out, "--remap-path-prefix", j.mirror+"="+filepath.Dir(j.srcArg))
}

// sync brings the mirror up to date: every .rs file instrumented at its
// functions' current tiers, everything else linked. It returns each source
// file's functions, for placing compile errors.
func (j *job) sync(tiers map[string]map[int]int) (map[string][]Func, error) {
	funcs := map[string][]Func{}
	wanted := map[string]bool{}
	count := 0
	rootFile := filepath.Join(j.srcDir, filepath.Base(j.srcArg))
	err := filepath.WalkDir(j.srcDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(j.srcDir, path)
		if entry.IsDir() {
			if name := entry.Name(); path != j.srcDir && (name == "target" || name == "node_modules" || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(j.mirror, rel), 0o755)
		}
		if count++; count > maxFiles {
			return fmt.Errorf("more than %d files beside the crate root", maxFiles)
		}
		target := filepath.Join(j.mirror, rel)
		wanted[target] = true
		if !strings.HasSuffix(path, ".rs") {
			return link(path, target)
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out, fns, err := Instrument(src, path, tiers[path])
		if err != nil {
			out = src
		}
		funcs[path] = fns
		if path == rootFile {
			out = append(append([]byte{}, out...), Recorder(j.cwd, j.unique, j.edition)...)
		}
		return writeIfChanged(target, out)
	})
	if err != nil {
		return nil, err
	}
	// A file deleted from the crate must not linger as a module.
	_ = filepath.WalkDir(j.mirror, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && !wanted[path] {
			os.Remove(path)
		}
		return nil
	})
	return funcs, nil
}

// link makes a non-source file (something include_str! reads, say) visible
// in the mirror: a symlink where the system allows, a copy where it does not.
func link(from, to string) error {
	if existing, err := os.Readlink(to); err == nil && existing == from {
		return nil
	}
	os.Remove(to)
	if err := os.Symlink(from, to); err == nil {
		return nil
	}
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return writeIfChanged(to, data)
}

// An unchanged file keeps its timestamp, so Cargo does not rebuild for it.
func writeIfChanged(path string, data []byte) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		return nil
	}
	return os.WriteFile(path, data, 0o644)
}

// demote reads the compiler's JSON diagnostics and drops every instrumented
// function that contains an error one tier. It reports whether any was.
func demote(stderr []byte, j *job, funcs map[string][]Func, tiers map[string]map[int]int) bool {
	changed := false
	// One step per attempt: an error names the same function in several spans.
	demoted := map[string]bool{}
	for _, line := range bytes.Split(stderr, []byte("\n")) {
		var message struct {
			Text  string `json:"message"`
			Level string `json:"level"`
			Spans []struct {
				File string `json:"file_name"`
				Line int    `json:"line_start"`
			} `json:"spans"`
		}
		if len(line) == 0 || line[0] != '{' || json.Unmarshal(line, &message) != nil || message.Level != "error" {
			continue
		}
		for _, span := range message.Spans {
			file := span.File
			if !filepath.IsAbs(file) {
				file = filepath.Join(j.cwd, file)
			}
			if real, err := filepath.EvalSymlinks(file); err == nil {
				file = real
			}
			// The innermost function on that line: a nested function's
			// error is its own, not its parent's.
			var hit *Func
			for i := range funcs[file] {
				fn := &funcs[file][i]
				if fn.StartLine <= span.Line && span.Line <= fn.EndLine && (hit == nil || fn.StartLine >= hit.StartLine) {
					hit = fn
				}
			}
			if hit == nil {
				continue
			}
			if tiers[file] == nil {
				tiers[file] = map[int]int{}
			}
			key := fmt.Sprintf("%s#%d", file, hit.Index)
			if tiers[file][hit.Index] < TierNone && !demoted[key] {
				demoted[key] = true
				tiers[file][hit.Index]++
				changed = true
				debugf("%s: %s in %s recorded less (tier %d): %s", j.crate, hit.Name, filepath.Base(file), tiers[file][hit.Index], message.Text)
			}
		}
	}
	return changed
}

// fixDepInfo points Cargo's dependency file back at the user's sources.
// rustc lists the files it read - the mirror's - and Cargo rebuilds when
// those change; it must rebuild when the user's do.
func (j *job) fixDepInfo() {
	data, err := os.ReadFile(j.depInfo)
	if err != nil {
		return
	}
	original := filepath.Dir(j.srcArg)
	// Make escapes spaces in paths with a backslash.
	escape := func(p string) string { return strings.ReplaceAll(p, " ", `\ `) }
	text := strings.ReplaceAll(string(data), escape(j.mirror), escape(original))
	text = strings.ReplaceAll(text, j.mirror, original)
	if text != string(data) {
		_ = os.WriteFile(j.depInfo, []byte(text), 0o644)
	}
}
