package runtime

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// A desktop app started from the Dock, Finder or a launcher inherits a minimal
// PATH (/usr/bin:/bin:...), not the one the user's shell builds. Node managers
// (fnm, nvm, volta), pyenv, Homebrew and ~/.cargo/bin all live outside it, so
// `npm test` works in their terminal and fails when Axiom runs it. Ask the
// user's shell once, the way it starts an interactive terminal, and cache it.

var (
	userPathOnce sync.Once
	userPath     string
)

const pathMarker = "__AXIOM_PATH__"

func loginShellPath() string {
	userPathOnce.Do(func() {
		if runtime.GOOS == "windows" {
			return // Windows GUI apps get the user's full PATH already
		}
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/zsh"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// -i sources the rc file where version managers usually hook in; -l the
		// profile. Markers fence off anything the rc files print themselves.
		cmd := exec.CommandContext(ctx, shell, "-ilc", `printf '%s%s%s' "`+pathMarker+`" "$PATH" "`+pathMarker+`"`)
		cmd.Stdin = nil
		out, err := cmd.Output()
		if err != nil && len(out) == 0 {
			return
		}
		text := string(out)
		start := strings.Index(text, pathMarker)
		end := strings.LastIndex(text, pathMarker)
		if start < 0 || end <= start {
			return
		}
		userPath = text[start+len(pathMarker) : end]
	})
	return userPath
}

// withUserPath returns env with PATH replaced by the user's shell PATH when
// that is richer than what archd inherited. Entries archd had are kept.
func withUserPath(env []string) []string {
	shellPath := loginShellPath()
	if shellPath == "" {
		return env
	}
	out := make([]string, 0, len(env)+1)
	current := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			current = kv[len("PATH="):]
			continue
		}
		out = append(out, kv)
	}
	seen := map[string]bool{}
	var merged []string
	for _, part := range append(strings.Split(shellPath, ":"), strings.Split(current, ":")...) {
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		merged = append(merged, part)
	}
	return append(out, "PATH="+strings.Join(merged, ":"))
}
