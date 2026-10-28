package gitworktree

import (
	"context"
	"os"
	"os/exec"
)

// Command is git run in dir. Ambio reads the user's repositories in the
// background, all the time; GIT_OPTIONAL_LOCKS=0 keeps those reads (above
// all `git status`, which otherwise refreshes the index) from writing to the
// repository, where they would race the user's own Git commands and wake
// Ambio's watcher of Git's metadata with changes nobody made.
func Command(dir string, args ...string) *exec.Cmd {
	return CommandContext(context.Background(), dir, args...)
}

// CommandContext is Command bounded by ctx.
func CommandContext(ctx context.Context, dir string, args ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	command.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	return command
}
