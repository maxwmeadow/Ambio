package gitworktree

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadStatusCountsChangesAndUpstream(t *testing.T) {
	remote := t.TempDir()
	headGit(t, remote, "init", "--bare", "-b", "main")
	repo := t.TempDir()
	headGit(t, repo, "init", "-b", "main")
	headGit(t, repo, "config", "user.email", "ambio-test@example.com")
	headGit(t, repo, "config", "user.name", "Ambio Test")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.go", "package a\n")
	write("b.go", "package a\n")
	headGit(t, repo, "add", ".")
	headGit(t, repo, "commit", "-m", "first")
	headGit(t, repo, "remote", "add", "origin", remote)
	headGit(t, repo, "push", "-u", "origin", "main")
	headGit(t, repo, "commit", "--allow-empty", "-m", "ahead")

	write("a.go", "package a\n\nfunc A() {}\n")
	headGit(t, repo, "mv", "b.go", "c.go")
	write("new.go", "package a\n")

	status, err := ReadStatus(repo)
	if err != nil {
		t.Fatal(err)
	}
	want := Status{ChangedFiles: 3, Upstream: "origin/main", Ahead: 1, Behind: 0}
	if status != want {
		t.Fatalf("status = %#v, want %#v", status, want)
	}
}
