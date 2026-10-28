package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Talking to a checkout's remote (docs/GIT_WORKFLOW.md stage 1): fetch, a
// fast-forward pull, push, and publishing a branch that has no upstream.
// These run only when the person asks. Git gets no terminal to prompt on, so
// a missing credential fails instead of waiting forever; saved credentials
// (a keychain, a credential manager, ssh-agent) work as in a terminal.

// SyncTimeout bounds one network operation.
const SyncTimeout = 2 * time.Minute

// SyncError is Git's refusal: the command that failed and Git's own words.
type SyncError struct {
	Args   []string
	Output string
	Err    error
}

func (e *SyncError) Error() string {
	if line := firstMeaningfulLine(e.Output); line != "" {
		return fmt.Sprintf("git %s: %s", strings.Join(e.Args, " "), line)
	}
	return fmt.Sprintf("git %s: %v", strings.Join(e.Args, " "), e.Err)
}

func (e *SyncError) Unwrap() error { return e.Err }

// firstMeaningfulLine is Git's first fatal or error line, else its first line.
func firstMeaningfulLine(output string) string {
	first := ""
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "hint:") {
			continue
		}
		if strings.HasPrefix(line, "fatal:") || strings.HasPrefix(line, "error:") || strings.HasPrefix(line, "! [") {
			return line
		}
		if first == "" {
			first = line
		}
	}
	return first
}

// syncGit runs a Git command that may reach the network, with combined output
// kept for the explanation when Git refuses.
func syncGit(ctx context.Context, path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, SyncTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", append([]string{"-C", path}, args...)...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never")
	output, err := command.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), &SyncError{Args: args, Output: string(output), Err: fmt.Errorf("no answer from the remote within %s", SyncTimeout)}
	}
	if err != nil {
		return string(output), &SyncError{Args: args, Output: string(output), Err: err}
	}
	return string(output), nil
}

// Fetch updates the remote-tracking branches of the checkout's upstream remote
// (or every remote when the branch has none). It never changes files or
// local branches.
func Fetch(ctx context.Context, path string) error {
	_, err := syncGit(ctx, path, "fetch", "--quiet")
	return err
}

// Pull brings the upstream's commits in when that is a fast-forward, and
// refuses otherwise; merging diverged branches is a separate, explicit step.
func Pull(ctx context.Context, path string) error {
	_, err := syncGit(ctx, path, "pull", "--ff-only", "--quiet")
	return err
}

// Push sends the branch's commits to its upstream. Never forced.
func Push(ctx context.Context, path string) error {
	_, err := syncGit(ctx, path, "push", "--quiet")
	return err
}

// Publish pushes a branch that has no upstream yet and makes remote/branch
// its upstream.
func Publish(ctx context.Context, path, remote, branch string) error {
	if remote == "" || branch == "" || strings.HasPrefix(remote, "-") || strings.HasPrefix(branch, "-") {
		return errors.New("a remote and a branch are required to publish")
	}
	_, err := syncGit(ctx, path, "push", "--quiet", "--set-upstream", remote, "HEAD:refs/heads/"+branch)
	return err
}

// Remotes lists the repository's remote names.
func Remotes(path string) ([]string, error) {
	output, err := gitOutput(path, "remote")
	if err != nil {
		return nil, err
	}
	remotes := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			remotes = append(remotes, line)
		}
	}
	return remotes, nil
}

// PublishRemote is where a branch without an upstream would be published: the
// only remote, or "origin" when there are several. Empty when there is no
// obvious choice.
func PublishRemote(remotes []string) string {
	if len(remotes) == 1 {
		return remotes[0]
	}
	for _, remote := range remotes {
		if remote == "origin" {
			return remote
		}
	}
	return ""
}

// FetchedAt is when the repository last heard from a remote (Git writes
// FETCH_HEAD on every fetch and pull), or zero if it never has.
func FetchedAt(path string) time.Time {
	common, err := gitCommonDir(path)
	if err != nil {
		return time.Time{}
	}
	info, err := os.Stat(filepath.Join(common, "FETCH_HEAD"))
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}
