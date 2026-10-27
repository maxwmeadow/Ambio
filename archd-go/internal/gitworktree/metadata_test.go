package gitworktree

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestMetadataWatcherReportsBranchHeadChanges(t *testing.T) {
	primary, branch, _ := gitChangeFixture(t)
	watcher, err := WatchMetadata(primary)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })

	writeGitFile(t, branch, "agent.go", "package agent\n")
	runGit(t, branch, "add", "agent.go")
	runGit(t, branch, "commit", "-m", "agent change")

	select {
	case <-watcher.Changes():
	case err := <-watcher.Errors():
		t.Fatalf("watch Git metadata: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for branch head metadata change")
	}
}

// An editor (or anything) running `git status` in a linked worktree rewrites
// that worktree's index under the shared .git; no checkout or branch moved,
// so it must not wake Ambio. Before, it re-synced every checkout each time.
func TestMetadataWatcherIgnoresAStatusInALinkedWorktree(t *testing.T) {
	primary, branch, _ := gitChangeFixture(t)
	watcher, err := WatchMetadata(primary)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })

	// A tracked file with a new timestamp: status refreshes the index.
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(filepath.Join(branch, "shared", "base.go"), later, later); err != nil {
		t.Fatal(err)
	}
	runGit(t, branch, "status")
	select {
	case <-watcher.Changes():
		t.Fatal("a status in a linked worktree was taken for a Git metadata change")
	case err := <-watcher.Errors():
		t.Fatalf("watch Git metadata: %v", err)
	case <-time.After(1500 * time.Millisecond):
	}
}

// Ambio's own reads take no optional locks, so they write nothing at all.
func TestCommandTakesNoOptionalLocks(t *testing.T) {
	_, branch, _ := gitChangeFixture(t)
	index := strings.TrimSpace(runGit(t, branch, "rev-parse", "--path-format=absolute", "--git-path", "index"))
	before, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(filepath.Join(branch, "shared", "base.go"), later, later); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if output, err := Command(branch, "status", "--porcelain").CombinedOutput(); err != nil {
		t.Fatalf("status: %v\n%s", err, output)
	}
	after, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("Ambio's git status rewrote the index")
	}
}

// Windows reports a write on a linked worktree's folder whenever a file in
// it is rewritten; only the folder appearing or going names a checkout.
func TestAWriteOnAWorktreeFolderIsNotACheckoutChange(t *testing.T) {
	common := t.TempDir()
	watcher := &MetadataWatcher{common: common}
	folder := filepath.Join(common, "worktrees", "agent")
	for _, test := range []struct {
		event fsnotify.Event
		want  bool
	}{
		{fsnotify.Event{Name: folder, Op: fsnotify.Write}, false},
		{fsnotify.Event{Name: filepath.Join(common, "worktrees"), Op: fsnotify.Write}, false},
		{fsnotify.Event{Name: folder, Op: fsnotify.Create}, true},
		{fsnotify.Event{Name: folder, Op: fsnotify.Remove}, true},
		{fsnotify.Event{Name: filepath.Join(folder, "HEAD"), Op: fsnotify.Write}, true},
		{fsnotify.Event{Name: filepath.Join(folder, "index"), Op: fsnotify.Write}, false},
	} {
		got := watcher.relevantPath(test.event.Name) && !watcher.folderWritten(test.event)
		if got != test.want {
			t.Errorf("%v %s: got %v, want %v", test.event.Op, test.event.Name, got, test.want)
		}
	}
}
