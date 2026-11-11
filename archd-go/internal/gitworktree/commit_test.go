package gitworktree

import (
	"strings"
	"testing"
)

func TestParseChangesReadsEachKindOfChangeRelativeToTheFolder(t *testing.T) {
	output := strings.Join([]string{
		"1 M. N... 100644 100644 100644 aaaa bbbb app/staged.go",
		"1 .M N... 100644 100644 100644 aaaa bbbb app/edited.go",
		"1 MM N... 100644 100644 100644 aaaa bbbb app/both.go",
		"1 .D N... 100644 100644 000000 aaaa bbbb app/gone.go",
		"2 R. N... 100644 100644 100644 aaaa bbbb R100 app/new name.go", "app/old.go",
		"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc app/conflict.go",
		"? app/fresh.go",
		"? other/outside.go",
		"",
	}, "\x00")
	changes := parseChanges([]byte(output), "app/")
	want := []Change{
		{Path: "staged.go", Staged: "M"},
		{Path: "edited.go", Unstaged: "M"},
		{Path: "both.go", Staged: "M", Unstaged: "M"},
		{Path: "gone.go", Unstaged: "D"},
		{Path: "new name.go", From: "old.go", Staged: "R"},
		{Path: "conflict.go", Unstaged: "U", Conflicted: true},
		{Path: "fresh.go", Unstaged: "U", Untracked: true},
	}
	if len(changes) != len(want) {
		t.Fatalf("changes = %#v", changes)
	}
	for index := range want {
		if changes[index] != want[index] {
			t.Errorf("change %d = %#v, want %#v", index, changes[index], want[index])
		}
	}
}

func TestSafePathRefusesOptionsAndPathsOutsideTheFolder(t *testing.T) {
	for _, name := range []string{"src/app.ts", "a b.txt", "x*y.go", ".env"} {
		if !SafePath(name) {
			t.Errorf("SafePath(%q) = false", name)
		}
	}
	for _, name := range []string{"", "-rf", "../up.txt", "a/../../up", "/etc/passwd", "C:/x", ":(top)x", "a\\b"} {
		if SafePath(name) {
			t.Errorf("SafePath(%q) = true", name)
		}
	}
}
