package runtime

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"axiom.local/archd/internal/runtime/gorecorder"
)

// injectGoOverlay instruments the workspace's Go modules for one run
// (gorecorder) and adds the overlay to GOFLAGS, keeping the user's own flags.
// It returns nil and a reason when Go runs cannot be recorded.
//
// -vet=off: `go test` vets dependencies for analysis facts, and vet reads
// package folders from disk, where the overlay-only recorder package does not
// exist. Tests still run; vet's findings are not what a repro run is for.
func injectGoOverlay(env []string, root, dir string) ([]string, string) {
	if root == "" {
		return nil, ""
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, ""
	}
	overlay, count, err := gorecorder.Build(root, dir)
	if err != nil || count == 0 {
		return nil, ""
	}
	if strings.ContainsAny(overlay, " \t") {
		// GOFLAGS is split on spaces with no quoting.
		return nil, "Go runs are not recorded when the temporary folder's path contains a space"
	}
	flags := "-overlay=" + overlay + " -vet=off"
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(kv, "GOFLAGS=") {
			existing := kv[len("GOFLAGS="):]
			if strings.Contains(existing, "-overlay") {
				return nil, "Go runs are not recorded when GOFLAGS already sets -overlay"
			}
			if existing != "" {
				flags = existing + " " + flags
			}
			continue
		}
		out = append(out, kv)
	}
	return append(out, "GOFLAGS="+flags), ""
}

var (
	goPanicLine = regexp.MustCompile(`(?m)^panic: (.+)$`)
	goFrame     = regexp.MustCompile(`(?m)^(\S[^\n]*?)\(.*\)\n\t(\S+\.go):(\d+)`)
)

// goPanics turns a Go panic in the run's output into an uncaught error pinned
// to the first frame in the user's code, as the other recorders report.
func goPanics(output, root string) []UncaughtError {
	m := goPanicLine.FindStringSubmatchIndex(output)
	if m == nil {
		return nil
	}
	what := "panic: " + strings.TrimSpace(output[m[2]:m[3]])
	rest := output[m[1]:]
	canonicalRoot := root
	if real, err := filepath.EvalSymlinks(root); err == nil {
		canonicalRoot = real
	}
	var frames []string
	for _, f := range goFrame.FindAllStringSubmatch(rest, 24) {
		file := f[2]
		if strings.Contains(file, "/axiomrecgen/") || !(strings.HasPrefix(file, root) || strings.HasPrefix(file, canonicalRoot)) {
			continue
		}
		name := f[1]
		if i := strings.LastIndex(name, "."); i >= 0 {
			name = name[i+1:]
		}
		frames = append(frames, "    at "+name+" ("+file+":"+f[3]+":1)")
		if len(frames) >= 12 {
			break
		}
	}
	if len(frames) == 0 {
		return nil
	}
	return []UncaughtError{{What: what, Stack: strings.Join(frames, "\n")}}
}

func nonEmpty(values ...string) []string {
	var out []string
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
