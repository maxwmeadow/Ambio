package indexer

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
)

func testRepository(t *testing.T) (string, func(args ...string)) {
	t.Helper()
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
	return repo, git
}

func TestHasConflictMarkers(t *testing.T) {
	for _, test := range []struct {
		text string
		want bool
	}{
		{"<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic\n", true},
		{"x\n<<<<<<< ours\na\n||||||| base\nc\n=======\nb\n>>>>>>> theirs\n", true},
		{"const fence = '=======';\n", false},
		{">>>>>>> theirs\n=======\n<<<<<<< ours\n", false},
	} {
		if got := hasConflictMarkers([]byte(test.text)); got != test.want {
			t.Errorf("%q: got %v, want %v", test.text, got, test.want)
		}
	}
}

// A merge that stops on a conflict writes markers into the file. Parsed,
// the file lost every import, and Review Changes listed the conflict as you
// deleting them; aborting put them back unjournaled. The file keeps its map
// until it is resolved.
func TestAConflictedFileKeepsItsMapUntilResolved(t *testing.T) {
	repo, git := testRepository(t)
	write := func(rel, content string) string {
		t.Helper()
		path := filepath.Join(repo, rel)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write("store.ts", "export function save() { return 1 }\n")
	app := write("app.ts", "import { save } from './store'\nexport function run() { return save() }\n")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	git("checkout", "-q", "-b", "topic")
	write("app.ts", "// topic\nimport { save } from './store'\nexport function run() { return save() }\n")
	git("commit", "-q", "-am", "topic")
	git("checkout", "-q", "main")
	write("app.ts", "// main\nimport { save } from './store'\nexport function run() { return save() }\n")
	git("commit", "-q", "-am", "main")

	sqlDB, root, h := journalFixture(t)
	root.Path = repo
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ForgetCheckout(root.ID) })
	if err := IndexRoot(sqlDB, h, root, nil); err != nil {
		t.Fatal(err)
	}
	if checkout, err := gitworktree.Locate(repo); err == nil {
		head, _ := checkout.ReadHead()
		SeedHead(root.ID, head)
	}
	events := func() int {
		var count int
		if err := sqlDB.QueryRow(`SELECT count(*) FROM structural_events`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	before := events()

	cmd := exec.Command("git", "-c", "user.email=ambio-test@example.com", "-c", "user.name=Ambio Test", "merge", "topic")
	cmd.Dir = repo
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("merge did not conflict:\n%s", out)
	}
	if !awaitingResolution(app) {
		t.Fatal("app.ts holds a conflict Git is waiting on")
	}
	for _, reindex := range []func() error{
		func() error { return ReindexFile(sqlDB, h, root, app) },
		func() error { _, err := ReindexBatch(sqlDB, h, root, []string{app}, nil); return err },
	} {
		if err := reindex(); err != nil {
			t.Fatal(err)
		}
		if edges := importEdges(t, sqlDB, root); len(edges) != 1 || edges[0] != "app.ts -> store.ts ×1" {
			t.Fatalf("imports while conflicted = %v, want app.ts's own", edges)
		}
		if got := events(); got != before {
			t.Fatalf("a conflict journaled %d events", got-before)
		}
	}

	// Resolved, it is a file again.
	write("app.ts", "export function run() { return 2 }\n")
	git("add", "app.ts")
	if awaitingResolution(app) {
		t.Fatal("a resolved file is not awaiting resolution")
	}
	if err := ReindexFile(sqlDB, h, root, app); err != nil {
		t.Fatal(err)
	}
	if edges := importEdges(t, sqlDB, root); len(edges) != 0 {
		t.Fatalf("imports once resolved = %v, want none", edges)
	}
}

// Markers committed as text (a fixture, a doc) are not a conflict.
func TestCommittedMarkersAreNotAConflict(t *testing.T) {
	repo, git := testRepository(t)
	path := filepath.Join(repo, "fixture.ts")
	if err := os.WriteFile(path, []byte("<<<<<<< a\n=======\n>>>>>>> b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-q", "-m", "fixture")
	if awaitingResolution(path) {
		t.Fatal("a committed file with marker text is not awaiting resolution")
	}
}

// A save in the minute after a cherry-pick is an edit, and animates like
// one; only files the cherry-pick wrote are Git's.
func TestASaveAfterACherryPickIsNotGits(t *testing.T) {
	repo, git := testRepository(t)
	picked := filepath.Join(repo, "picked.go")
	saved := filepath.Join(repo, "saved.go")
	for _, path := range []string{picked, saved} {
		if err := os.WriteFile(path, []byte("package app\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("add", ".")
	git("commit", "-q", "-m", "base")
	git("checkout", "-q", "-b", "topic")
	if err := os.WriteFile(picked, []byte("package app\n\nfunc Picked() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("commit", "-q", "-am", "pick me")
	git("checkout", "-q", "main")

	checkout, err := gitworktree.Locate(repo)
	if err != nil {
		t.Fatal(err)
	}
	head, _ := checkout.ReadHead()
	root := db.Root{ID: "pick-" + t.Name(), WorkspaceID: "ws", Path: repo, Branch: "main"}
	t.Cleanup(func() { ForgetCheckout(root.ID) })
	SeedHead(root.ID, head)
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()

	git("cherry-pick", "topic")
	if !GitWroteAny(sqlDB, root, []string{picked}) {
		t.Fatal("the cherry-pick wrote picked.go")
	}
	if err := os.WriteFile(saved, []byte("package app\n\nfunc Saved() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if GitWroteAny(sqlDB, root, []string{saved}) {
		t.Fatal("saved.go is an edit made after the cherry-pick")
	}
}
