package gitworktree

import (
	"bytes"
	"fmt"
	"strings"
)

// Ambio changes a repository in exactly these ways (docs/DECISIONS.md
// 2026-10-20 "Git: one map, many checkouts"): it adds and removes worktrees
// for the agents it runs, switches the Floor's checkout to another branch
// when asked, and applies an Ambio run's changes to a checkout as uncommitted
// changes. It never commits, merges, pushes or deletes a branch it did not
// create.

// AddWorktree creates a worktree at path on a new branch started from base.
func AddWorktree(repoPath, path, branch, base string) error {
	_, err := gitOutput(repoPath, "worktree", "add", "-b", branch, path, base)
	return err
}

// RemoveWorktree removes an Ambio-made worktree and, when deleteBranch is
// set, the branch Ambio made for it. Uncommitted changes in it are lost.
func RemoveWorktree(repoPath, path, branch string, deleteBranch bool) error {
	if _, err := gitOutput(repoPath, "worktree", "remove", "--force", path); err != nil {
		return err
	}
	if deleteBranch && branch != "" {
		_, err := gitOutput(repoPath, "branch", "-D", branch)
		return err
	}
	return nil
}

// Switch checks out another branch in a checkout. Git refuses a branch that
// is checked out in another worktree; the error says so.
func Switch(path, branch string) error {
	_, err := gitOutput(path, "switch", branch)
	return err
}

// LocalBranches lists local branch names, most recently committed first.
func LocalBranches(path string) ([]string, error) {
	output, err := gitOutput(path, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return nil, err
	}
	branches := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line != "" {
			branches = append(branches, line)
		}
	}
	return branches, nil
}

// ChangesAsPatch is everything a worktree changes since base - commits and
// uncommitted work, new files included - as one binary patch. It stages the
// worktree's files to see untracked ones, which is safe only in a worktree
// Ambio made for its own run.
func ChangesAsPatch(worktreePath, base string) ([]byte, []string, error) {
	if _, err := gitOutput(worktreePath, "add", "-A"); err != nil {
		return nil, nil, err
	}
	names, err := gitOutput(worktreePath, "diff", "--cached", "--name-only", "-z", base)
	if err != nil {
		return nil, nil, err
	}
	patch, err := gitOutput(worktreePath, "diff", "--cached", "--binary", "--full-index", base)
	if err != nil {
		return nil, nil, err
	}
	return patch, normalizedPaths(names), nil
}

// ApplyPatch applies a patch to a checkout's working tree, leaving it
// uncommitted. It is tried cleanly first; failing that, as a three-way merge
// that leaves conflict markers, and conflicted reports that it did.
func ApplyPatch(path string, patch []byte) (conflicted bool, err error) {
	if len(bytes.TrimSpace(patch)) == 0 {
		return false, nil
	}
	if _, err := gitInput(path, patch, "apply", "--whitespace=nowarn"); err == nil {
		return false, nil
	}
	if _, err := gitInput(path, patch, "apply", "--3way", "--whitespace=nowarn"); err != nil {
		// --3way exits non-zero both on conflicts it wrote and on patches it
		// could not apply at all; only the first leaves anything behind.
		if unmerged, statusErr := gitOutput(path, "diff", "--name-only", "--diff-filter=U"); statusErr == nil && len(bytes.TrimSpace(unmerged)) > 0 {
			return true, nil
		}
		return false, err
	}
	return false, nil
}

func gitInput(path string, input []byte, args ...string) ([]byte, error) {
	command := Command(path, args...)
	command.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s in %s: %w: %s", strings.Join(args, " "), path, err, strings.TrimSpace(stderr.String()))
	}
	return output, nil
}
