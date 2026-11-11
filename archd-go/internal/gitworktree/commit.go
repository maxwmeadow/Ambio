package gitworktree

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path"
	"strings"
	"time"
)

// Committing from Ambio (docs/GIT_WORKFLOW.md stage 2): the checkout's changed
// files, staging and unstaging them, discarding a file's changes, and the
// commit itself. These run only when the person asks.

// CommitTimeout bounds one staging or commit command; hooks run inside it.
const CommitTimeout = 2 * time.Minute

// Change is one changed path in a checkout, relative to the checkout's folder,
// with Git's own one-letter states: Staged for the index against HEAD,
// Unstaged for the working tree against the index ("" when unchanged).
type Change struct {
	Path string `json:"path"`
	// From is a rename's or copy's original path.
	From       string `json:"from,omitempty"`
	Staged     string `json:"staged,omitempty"`
	Unstaged   string `json:"unstaged,omitempty"`
	Untracked  bool   `json:"untracked,omitempty"`
	Conflicted bool   `json:"conflicted,omitempty"`
}

// ReadChanges lists every changed path in the checkout's folder, untracked
// files one by one, as the person would stage them.
func ReadChanges(dir string) ([]Change, error) {
	prefixOutput, err := gitOutput(dir, "rev-parse", "--show-prefix")
	if err != nil {
		return nil, err
	}
	output, err := gitOutput(dir, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ".")
	if err != nil {
		return nil, err
	}
	return parseChanges(output, strings.TrimSpace(string(prefixOutput))), nil
}

// parseChanges reads `git status --porcelain=v2 -z`, whose paths are relative
// to the repository; prefix is the checkout folder's place in it.
func parseChanges(output []byte, prefix string) []Change {
	relative := func(name string) (string, bool) {
		if prefix == "" {
			return name, true
		}
		if !strings.HasPrefix(name, prefix) {
			return "", false
		}
		return strings.TrimPrefix(name, prefix), true
	}
	state := func(letter byte) string {
		if letter == '.' {
			return ""
		}
		return string(letter)
	}
	changes := []Change{}
	fields := bytes.Split(output, []byte{0})
	for index := 0; index < len(fields); index++ {
		field := string(fields[index])
		var change Change
		var name string
		switch {
		case strings.HasPrefix(field, "1 "):
			parts := strings.SplitN(field, " ", 9)
			if len(parts) < 9 {
				continue
			}
			change.Staged, change.Unstaged, name = state(parts[1][0]), state(parts[1][1]), parts[8]
		case strings.HasPrefix(field, "2 "):
			parts := strings.SplitN(field, " ", 10)
			if len(parts) < 10 || index+1 >= len(fields) {
				continue
			}
			change.Staged, change.Unstaged, name = state(parts[1][0]), state(parts[1][1]), parts[9]
			index++
			if from, ok := relative(string(fields[index])); ok {
				change.From = from
			}
		case strings.HasPrefix(field, "u "):
			parts := strings.SplitN(field, " ", 11)
			if len(parts) < 11 {
				continue
			}
			change.Conflicted, change.Unstaged, name = true, "U", parts[10]
		case strings.HasPrefix(field, "? "):
			change.Untracked, change.Unstaged, name = true, "U", strings.TrimPrefix(field, "? ")
		default:
			continue
		}
		var ok bool
		if change.Path, ok = relative(name); ok && change.Path != "" {
			changes = append(changes, change)
		}
	}
	return changes
}

// SafePath reports whether name is a plain path inside the checkout folder,
// which a Git pathspec cannot read as an option or reach outside the folder.
func SafePath(name string) bool {
	if name == "" || strings.HasPrefix(name, "-") || strings.HasPrefix(name, "/") || strings.HasPrefix(name, ":") ||
		strings.ContainsAny(name, "\\\x00") || len(name) > 1 && name[1] == ':' {
		return false
	}
	for _, part := range strings.Split(path.Clean(name), "/") {
		if part == ".." {
			return false
		}
	}
	return true
}

// writeGit runs a Git command that changes the checkout, with its combined
// output kept for the explanation when Git refuses. Git has no terminal to
// prompt on, so a hook or signing step that would ask fails instead of
// waiting.
func writeGit(ctx context.Context, dir string, stdin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, CommitTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never")
	if stdin != "" {
		command.Stdin = strings.NewReader(stdin)
	}
	output, err := command.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), &SyncError{Args: args, Output: string(output), Err: errors.New("git did not finish in time")}
	}
	if err != nil {
		return string(output), &SyncError{Args: args, Output: string(output), Err: err}
	}
	return string(output), nil
}

// Stage adds the paths' changes, including deletions and new files, to the
// index.
func Stage(ctx context.Context, dir string, paths []string) error {
	_, err := writeGit(ctx, dir, "", append([]string{"add", "--all", "--"}, literal(paths)...)...)
	return err
}

// Unstage takes the paths' changes back out of the index, leaving the files
// as they are. A repository with no commit yet has no HEAD to restore from.
func Unstage(ctx context.Context, dir string, paths []string) error {
	if _, err := gitOutput(dir, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
		_, err := writeGit(ctx, dir, "", append([]string{"rm", "--cached", "-r", "--quiet", "--"}, literal(paths)...)...)
		return err
	}
	_, err := writeGit(ctx, dir, "", append([]string{"restore", "--staged", "--"}, literal(paths)...)...)
	return err
}

// Discard throws away the paths' unstaged changes: a tracked file goes back
// to what is staged (or committed), and an untracked file is deleted.
// Staged changes are kept.
func Discard(ctx context.Context, dir string, changes []Change) error {
	var tracked, untracked []string
	for _, change := range changes {
		if change.Untracked {
			untracked = append(untracked, change.Path)
		} else {
			tracked = append(tracked, change.Path)
		}
	}
	if len(tracked) > 0 {
		if _, err := writeGit(ctx, dir, "", append([]string{"restore", "--worktree", "--"}, literal(tracked)...)...); err != nil {
			return err
		}
	}
	if len(untracked) > 0 {
		if _, err := writeGit(ctx, dir, "", append([]string{"clean", "--force", "--quiet", "--"}, literal(untracked)...)...); err != nil {
			return err
		}
	}
	return nil
}

// Commit records what is staged with message; with all, it first stages every
// change in the checkout folder. It returns the new commit's short hash.
func Commit(ctx context.Context, dir, message string, all bool) (string, error) {
	if all {
		if _, err := writeGit(ctx, dir, "", "add", "--all", "--", "."); err != nil {
			return "", err
		}
	}
	if _, err := writeGit(ctx, dir, message, "commit", "--quiet", "--file=-"); err != nil {
		return "", err
	}
	output, err := gitOutput(dir, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", nil
	}
	return strings.TrimSpace(string(output)), nil
}

// literal marks each path as a literal pathspec, so a name with * or ? in it
// means only that file.
func literal(paths []string) []string {
	out := make([]string, len(paths))
	for index, name := range paths {
		out[index] = ":(literal)" + name
	}
	return out
}
