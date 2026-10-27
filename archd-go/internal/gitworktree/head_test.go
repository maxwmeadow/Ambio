package gitworktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func headGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	output, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func TestReadHeadFollowsGitThroughEveryState(t *testing.T) {
	repo := t.TempDir()
	headGit(t, repo, "init", "-b", "main")
	headGit(t, repo, "config", "user.email", "ambio-test@example.com")
	headGit(t, repo, "config", "user.name", "Ambio Test")
	checkout, err := Locate(repo)
	if err != nil {
		t.Fatal(err)
	}
	if head, err := checkout.ReadHead(); err != nil || head != (Head{Branch: "main"}) {
		t.Fatalf("unborn HEAD = %#v, %v", head, err)
	}

	if err := os.WriteFile(filepath.Join(repo, "a.go"), []byte("package a\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	headGit(t, repo, "add", ".")
	headGit(t, repo, "commit", "-m", "first")
	first := headGit(t, repo, "rev-parse", "HEAD")
	if head, _ := checkout.ReadHead(); head != (Head{Branch: "main", Commit: first}) {
		t.Fatalf("loose ref HEAD = %#v", head)
	}
	headGit(t, repo, "pack-refs", "--all")
	if head, _ := checkout.ReadHead(); head != (Head{Branch: "main", Commit: first}) {
		t.Fatalf("packed ref HEAD = %#v", head)
	}
	headGit(t, repo, "checkout", "--detach")
	if head, _ := checkout.ReadHead(); head != (Head{Branch: DetachedBranch, Commit: first}) {
		t.Fatalf("detached HEAD = %#v", head)
	}

	blob := headGit(t, repo, "rev-parse", "HEAD:a.go")
	// With core.autocrlf the blob holds LF and the file CRLF; either way the
	// file on disk is the committed content.
	if !ContentMatchesBlob([]byte("package a\r\n"), blob) {
		t.Fatalf("the working file does not match %s", blob)
	}
	tree, err := checkout.TreeBlobs(first)
	if err != nil || tree["a.go"] != blob {
		t.Fatalf("TreeBlobs = %#v, %v", tree, err)
	}
}

func TestHeadMessagesCoverOnlyTheMove(t *testing.T) {
	repo := t.TempDir()
	headGit(t, repo, "init", "-b", "main")
	headGit(t, repo, "config", "user.email", "ambio-test@example.com")
	headGit(t, repo, "config", "user.name", "Ambio Test")
	headGit(t, repo, "commit", "--allow-empty", "-m", "first")
	first := headGit(t, repo, "rev-parse", "HEAD")
	headGit(t, repo, "checkout", "-b", "feature")
	headGit(t, repo, "commit", "--allow-empty", "-m", "second")
	second := headGit(t, repo, "rev-parse", "HEAD")
	checkout, err := Locate(repo)
	if err != nil {
		t.Fatal(err)
	}

	mainAt := func(commit string) Head { return Head{Branch: "main", Commit: commit} }
	featureAt := func(commit string) Head { return Head{Branch: "feature", Commit: commit} }
	messages := checkout.HeadMessages(mainAt(first), featureAt(second))
	if len(messages) != 2 || !strings.HasPrefix(messages[0], "checkout: moving from main to feature") ||
		!strings.HasPrefix(messages[1], "commit: second") {
		t.Fatalf("messages = %#v", messages)
	}
	if messages := checkout.HeadMessages(featureAt(first), featureAt(second)); len(messages) != 1 || !strings.HasPrefix(messages[0], "commit: second") {
		t.Fatalf("commit only = %#v", messages)
	}
	if messages := checkout.HeadMessages(Head{Branch: "main"}, mainAt(first)); messages != nil {
		t.Fatalf("a move that is not the newest entry must be unknown, got %#v", messages)
	}
	if messages := checkout.HeadMessages(Head{Branch: "main"}, featureAt(second)); len(messages) != 3 || !strings.HasPrefix(messages[0], "commit (initial)") {
		t.Fatalf("from unborn = %#v", messages)
	}
}

func TestLocateReportsTheOpenedSubfolder(t *testing.T) {
	repo := t.TempDir()
	headGit(t, repo, "init", "-b", "main")
	web := filepath.Join(repo, "packages", "web")
	if err := os.MkdirAll(web, 0o755); err != nil {
		t.Fatal(err)
	}
	checkout, err := Locate(web)
	if err != nil {
		t.Fatal(err)
	}
	if checkout.Prefix != "packages/web/" {
		t.Fatalf("prefix = %q", checkout.Prefix)
	}
	if _, err := Locate(t.TempDir()); err == nil {
		t.Fatal("a plain folder must not locate a checkout")
	}
}

func TestFindRepositoriesListsNestedRepositoriesOnce(t *testing.T) {
	parent := t.TempDir()
	for _, repo := range []string{"web", "services/api", "services/api/vendor/sdk"} {
		dir := filepath.Join(parent, filepath.FromSlash(repo))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		headGit(t, dir, "init", "-q")
	}
	if err := os.MkdirAll(filepath.Join(parent, "node_modules", "dep", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	found := FindRepositories(parent, 3, func(_ string, name string) bool { return name == "node_modules" })
	if strings.Join(found, ",") != "services/api,web" {
		t.Fatalf("found = %v", found)
	}
}

// Checkout releases index.lock before it takes HEAD.lock: a file event read
// in between must still wait for HEAD to move.
func TestBusyCoversTheGapBeforeHeadMoves(t *testing.T) {
	checkout := Checkout{GitDir: t.TempDir()}
	write := func(name string, at time.Time) {
		path := filepath.Join(checkout.GitDir, name)
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	long := time.Now().Add(-time.Hour)
	write("index", long)
	if checkout.Busy(10 * time.Second) {
		t.Fatal("no lock, no command running")
	}
	write("HEAD.lock", time.Now())
	if !checkout.Busy(10 * time.Second) {
		t.Fatal("HEAD.lock is HEAD moving")
	}
	write("HEAD.lock", long)
	if checkout.Busy(10 * time.Second) {
		t.Fatal("a stale HEAD.lock is left from a crash")
	}
	if checkout.IndexJustWritten() {
		t.Fatal("the index was written an hour ago")
	}
	write("index", time.Now())
	if !checkout.IndexJustWritten() {
		t.Fatal("an index just written may be followed by HEAD moving")
	}
}

func TestWasRenamedFollowsAChainOfRenames(t *testing.T) {
	repo := t.TempDir()
	headGit(t, repo, "init", "-q", "-b", "main")
	headGit(t, repo, "-c", "user.email=a@b.c", "-c", "user.name=A", "commit", "-q", "--allow-empty", "-m", "base")
	checkout, err := Locate(repo)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := checkout.ReadHead()
	headGit(t, repo, "branch", "-m", "main", "trunk")
	headGit(t, repo, "branch", "-m", "trunk", "stem")
	after, _ := checkout.ReadHead()
	if !checkout.WasRenamed(before, after) {
		t.Fatal("main became stem by two renames")
	}
	headGit(t, repo, "checkout", "-q", "-b", "other")
	switched, _ := checkout.ReadHead()
	if checkout.WasRenamed(after, switched) {
		t.Fatal("checkout -b is a new branch, not a rename")
	}
}
