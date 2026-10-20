package indexer

import (
	"testing"

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
