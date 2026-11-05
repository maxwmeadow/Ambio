package gitworktree

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCommittedFileReadsHeadsVersionOfAWorkingFile(t *testing.T) {
	repo := t.TempDir()
	headGit(t, repo, "init", "-b", "main")
	headGit(t, repo, "config", "user.email", "ambio-test@example.com")
	headGit(t, repo, "config", "user.name", "Ambio Test")
	headGit(t, repo, "config", "core.autocrlf", "false")
	if err := os.MkdirAll(filepath.Join(repo, "robot"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repo, "robot", "heuristics.py")
	if err := os.WriteFile(path, []byte("a = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Before the first commit the branch is unborn: the file is simply new.
	if committed, err := CommittedFile(path); err != nil || committed.Tracked || committed.Content != nil {
		t.Fatalf("unborn: %+v, %v", committed, err)
	}
	headGit(t, repo, "add", ".")
	before := time.Now().Add(-time.Minute).Unix()
	headGit(t, repo, "commit", "-m", "first")
	if err := os.WriteFile(path, []byte("a = 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	committed, err := CommittedFile(path)
	if err != nil || !committed.Tracked || string(committed.Content) != "a = 1\n" || committed.At < before {
		t.Fatalf("committed: %+v, %v", committed, err)
	}
	fresh := filepath.Join(repo, "robot", "new.py")
	if err := os.WriteFile(fresh, []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if committed, err := CommittedFile(fresh); err != nil || committed.Tracked {
		t.Fatalf("untracked: %+v, %v", committed, err)
	}
	outside := filepath.Join(t.TempDir(), "loose.py")
	if err := os.WriteFile(outside, []byte("c\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := CommittedFile(outside); err == nil {
		t.Fatal("a file outside any checkout reported a committed version")
	}
}
