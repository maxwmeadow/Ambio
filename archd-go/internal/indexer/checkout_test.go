package indexer

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
)

func TestClassifyHeadMoveReadsTheReflog(t *testing.T) {
	main := gitworktree.Head{Branch: "main", Commit: "a"}
	feature := gitworktree.Head{Branch: "feature", Commit: "b"}
	later := gitworktree.Head{Branch: "main", Commit: "c"}
	for _, test := range []struct {
		name     string
		messages []string
		from, to gitworktree.Head
		want     headMoveKind
	}{
		{"switch", []string{"checkout: moving from main to feature"}, main, feature, moveSwitch},
		{"switch then commit", []string{"checkout: moving from main to feature", "commit: wip"}, main, feature, moveSwitch},
		{"commit", []string{"commit: add billing"}, main, later, moveCommit},
		{"amend", []string{"commit (amend): add billing"}, main, later, moveCommit},
		{"pull", []string{"pull: Fast-forward"}, main, later, moveGit},
		{"commit then reset", []string{"commit: x", "reset: moving to HEAD~2"}, main, later, moveGit},
		{"rebase", []string{"rebase (start): checkout main", "rebase (finish): returning to refs/heads/main"}, main, later, moveGit},
		{"no reflog, new branch", nil, main, feature, moveSwitch},
		{"no reflog, same branch", nil, main, later, moveCommit},
	} {
		if got := classifyHeadMove(test.messages, test.from, test.to); got != test.want {
			t.Errorf("%s: got %v, want %v", test.name, got, test.want)
		}
	}
}

// git checkout writes the files and the index, releases index.lock, and only
// then moves HEAD. A file event read in that gap must still be the switch,
// not an edit on the old branch (it was, on slow Windows runners).
func TestAFileWrittenBeforeHeadMovesIsStillTheSwitch(t *testing.T) {
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.email=ambio-test@example.com", "-c", "user.name=Ambio Test"}, args...)...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	git("commit", "-q", "--allow-empty", "-m", "base")
	git("checkout", "-q", "-b", "feature")
	cart := filepath.Join(repo, "cart.go")
	if err := os.WriteFile(cart, []byte("package app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-q", "-m", "cart")
	git("checkout", "-q", "main")

	checkout, err := gitworktree.Locate(repo)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := checkout.ReadHead()
	root := db.Root{ID: "gap-" + t.Name(), WorkspaceID: "ws", Path: repo, Branch: "main"}
	t.Cleanup(func() { ForgetCheckout(root.ID) })
	SeedHead(root.ID, before)

	// The checkout as a file event sees it mid-way: files and index are the
	// feature branch's, HEAD still names main until Git gets to it.
	git("checkout", "-q", "feature")
	headFile := filepath.Join(checkout.GitDir, "HEAD")
	if err := os.WriteFile(headFile, []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := os.Chtimes(filepath.Join(checkout.GitDir, "index"), now, now); err != nil {
		t.Fatal(err)
	}
	moved := make(chan struct{})
	go func() {
		defer close(moved)
		time.Sleep(200 * time.Millisecond)
		_ = os.WriteFile(headFile, []byte("ref: refs/heads/feature\n"), 0o644)
	}()
	defer func() { <-moved }()

	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if got := gitWrote(sqlDB, root, "cart.go", cart, false); got != moveSwitch {
		t.Fatalf("cart.go written by the checkout: got %v, want the switch", got)
	}
}
