package indexer

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ambio.local/archd/internal/activity"
	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
)

// Git rewrites files too, and that is not anybody writing code. Switching to
// another branch replaces the working tree with that branch's files; the map
// has to follow, but the journal must not record the new branch's code as
// edits made just now (and, since the watcher's batch lands before the HEAD
// monitor updates the root, on the wrong branch).
//
// So before a file change is journaled, the checkout's HEAD is read. If it
// moved since the journal last looked, the move is classified from the
// reflog:
//
//   - a commit changes nothing on disk, so files keep their usual attribution;
//   - a branch switch makes the files Git wrote quiet, like a re-scope, and
//     leaves one checkout.switched row on the branch it switched to;
//   - a pull, merge, reset or rebase is journaled, but as Git's doing: it is
//     reviewable ("what arrived when I pulled") without being credited to you.
//
// A file counts as written by Git only if its content is exactly the new
// commit's blob and that blob differs from the old commit's, so edits carried
// across a switch, or made while it ran, are still journaled.

type headMoveKind int

const (
	moveNone headMoveKind = iota
	moveCommit
	moveSwitch
	moveGit
)

const (
	// A move explains file events for this long after it was seen, or after
	// the last file it explained: a large checkout lands in waves.
	gitMoveWindow = 60 * time.Second
	// How long a file event waits for a running Git command to finish.
	gitBusyWait  = 15 * time.Second
	gitLockStale = 10 * time.Second
	// How often a folder that is not a Git checkout is asked again, so
	// `git init` is noticed.
	notGitRetry = 5 * time.Second
)

type headMove struct {
	from, to    gitworktree.Head
	kind        headMoveKind
	lastHit     time.Time
	treesLoaded bool
	fromTree    map[string]string
	toTree      map[string]string
}

type checkoutState struct {
	mu sync.Mutex
	// repository is a repository nested inside the root (one of several under
	// a parent folder, or a submodule), relative to the root; "" for the
	// root's own repository.
	repository string
	checkout   gitworktree.Checkout
	located    bool
	lookedAt   time.Time
	head       gitworktree.Head
	headKnown  bool
	move       *headMove
}

var (
	checkoutsMu sync.Mutex
	checkouts   = map[string]*checkoutState{}
)

func checkoutFor(rootID string) *checkoutState {
	checkoutsMu.Lock()
	defer checkoutsMu.Unlock()
	state := checkouts[rootID]
	if state == nil {
		state = &checkoutState{}
		checkouts[rootID] = state
	}
	return state
}

// SeedHead tells the journal which HEAD a root was last indexed at. Without
// it, a branch switched while Ambio was closed would be taken as the starting
// point, and catching up would journal the whole difference as edits.
func SeedHead(rootID string, head gitworktree.Head) {
	if strings.Trim(head.Commit, "0") == "" {
		head.Commit = "" // git worktree list prints an unborn HEAD as zeros
	}
	if head.Branch == "" && head.Commit == "" {
		return
	}
	state := checkoutFor(rootID)
	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.headKnown {
		state.head, state.headKnown = head, true
	}
}

// SeedRepositories records the HEAD of each repository nested in a root, so
// the first branch switch inside one is recognized as a switch.
func SeedRepositories(root db.Root, repositories []string) {
	for _, repository := range repositories {
		checkout, err := gitworktree.Locate(filepath.Join(root.Path, filepath.FromSlash(repository)))
		if err != nil {
			continue
		}
		head, err := checkout.ReadHead()
		if err != nil {
			continue
		}
		state := checkoutFor(root.ID + "|" + repository)
		state.mu.Lock()
		if !state.headKnown {
			state.repository, state.checkout, state.located = repository, checkout, true
			state.head, state.headKnown = head, true
		}
		state.mu.Unlock()
	}
}

// NoteHead records a HEAD move as soon as Git's metadata reports it, so a
// switch between branches with identical trees, which changes no file, is
// still journaled once.
func NoteHead(sqlDB *sql.DB, root db.Root) {
	state := checkoutFor(root.ID)
	state.mu.Lock()
	defer state.mu.Unlock()
	state.observe(sqlDB, root)
}

// ForgetCheckout drops what the journal knows about a root's Git state,
// including the repositories nested in it.
func ForgetCheckout(rootID string) {
	checkoutsMu.Lock()
	for key := range checkouts {
		if key == rootID || strings.HasPrefix(key, rootID+"|") {
			delete(checkouts, key)
		}
	}
	checkoutsMu.Unlock()
}

// nestedRepository is the repository nested inside root that holds absPath,
// relative to root, or "" when the file belongs to the root's own repository
// (or none). One stat per folder between the file and the root.
func nestedRepository(root db.Root, absPath string) string {
	rootPath := filepath.Clean(root.Path)
	for dir := filepath.Dir(absPath); len(dir) > len(rootPath); dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			if rel, relErr := filepath.Rel(rootPath, dir); relErr == nil && !strings.HasPrefix(rel, "..") {
				return filepath.ToSlash(rel)
			}
			return ""
		}
		if parent := filepath.Dir(dir); parent == dir {
			break
		}
	}
	return ""
}

// currentHead is the HEAD the journal last read for a root, which is fresher
// than the watcher's copy of the root row during a switch.
func currentHead(rootID string) (gitworktree.Head, bool) {
	checkoutsMu.Lock()
	state := checkouts[rootID]
	checkoutsMu.Unlock()
	if state == nil {
		return gitworktree.Head{}, false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.head, state.located && state.headKnown
}

// activeMove is the kind of a HEAD move still explaining file events, in the
// root's own repository or one nested in it; a switch outranks the rest.
func activeMove(rootID string) headMoveKind {
	checkoutsMu.Lock()
	var states []*checkoutState
	for key, state := range checkouts {
		if key == rootID || strings.HasPrefix(key, rootID+"|") {
			states = append(states, state)
		}
	}
	checkoutsMu.Unlock()
	kind := moveNone
	for _, state := range states {
		state.mu.Lock()
		if state.move != nil && time.Since(state.move.lastHit) <= gitMoveWindow && (kind == moveNone || state.move.kind == moveSwitch) {
			kind = state.move.kind
		}
		state.mu.Unlock()
	}
	return kind
}

// observe reads HEAD once a running Git command has finished, and records a
// move. The caller holds state.mu.
func (state *checkoutState) observe(sqlDB *sql.DB, root db.Root) bool {
	if !state.located {
		if !state.lookedAt.IsZero() && time.Since(state.lookedAt) < notGitRetry {
			return false
		}
		state.lookedAt = time.Now()
		folder := root.Path
		if state.repository != "" {
			folder = filepath.Join(root.Path, filepath.FromSlash(state.repository))
		}
		checkout, err := gitworktree.Locate(folder)
		if err != nil {
			return false
		}
		state.checkout, state.located = checkout, true
	}
	// Checkout writes the index before it moves HEAD, so an index written
	// just now with HEAD where it was may be a switch still under way.
	for deadline := time.Now().Add(gitBusyWait); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if state.checkout.Busy(gitLockStale) {
			continue
		}
		if state.headKnown && state.checkout.IndexJustWritten() {
			if head, err := state.checkout.ReadHead(); err == nil && head == state.head {
				continue
			}
		}
		break
	}
	head, err := state.checkout.ReadHead()
	if err != nil {
		log.Printf("journal: read HEAD for %s: %v", root.Path, err)
		return false
	}
	if !state.headKnown {
		state.head, state.headKnown = head, true
		return true
	}
	if head == state.head {
		return true
	}
	move := &headMove{
		from: state.head, to: head, lastHit: time.Now(),
		kind: classifyHeadMove(state.checkout.HeadMessages(state.head, head), state.head, head),
	}
	state.head, state.move = head, move
	if move.kind == moveSwitch {
		// A nested repository's switch belongs to the root's history, which
		// is not kept per that repository's branch; it names the repository.
		branch, label := head.Branch, head.Branch
		if state.repository != "" {
			branch, label = root.Branch, state.repository+": "+head.Branch
		}
		// recordEvent, not recordRootEvent: the latter reads currentHead, which
		// needs the lock held here.
		recordEvent(sqlDB, db.StructuralEvent{
			WorkspaceID:  root.WorkspaceID,
			RootID:       root.ID,
			Branch:       branch,
			Actor:        activity.ActorGit,
			Kind:         db.EventCheckoutSwitched,
			SubjectLabel: label,
			Detail: encodeDetail(map[string]string{
				"repository": state.repository,
				"fromBranch": move.from.Branch,
				"fromCommit": move.from.Commit,
				"toCommit":   head.Commit,
			}),
		})
	}
	return true
}

// classifyHeadMove reads what moved HEAD from the reflog messages covering
// the move. Without a reflog, a change of branch is a switch and anything
// else is treated like a commit, which is how every change was treated before.
func classifyHeadMove(messages []string, from, to gitworktree.Head) headMoveKind {
	if len(messages) == 0 {
		if from.Branch != to.Branch {
			return moveSwitch
		}
		return moveCommit
	}
	onlyCommits := true
	for _, message := range messages {
		action, _, _ := strings.Cut(message, ":")
		switch {
		case action == "checkout":
			return moveSwitch
		case strings.HasPrefix(action, "commit"):
		default:
			onlyCommits = false
		}
	}
	if onlyCommits {
		return moveCommit
	}
	return moveGit
}

// gitWrote reports whether Git, rather than a person or an agent, produced
// this file change, and which kind of move it belonged to.
func gitWrote(sqlDB *sql.DB, root db.Root, relPath, absPath string, deleted bool) headMoveKind {
	key := root.ID
	repository := nestedRepository(root, absPath)
	if repository != "" {
		key = root.ID + "|" + repository
		// Paths in a nested repository's trees are relative to it.
		relPath = strings.TrimPrefix(relPath, repository+"/")
	}
	state := checkoutFor(key)
	state.mu.Lock()
	state.repository = repository
	defer state.mu.Unlock()
	if !state.observe(sqlDB, root) {
		return moveNone
	}
	move := state.move
	if move == nil || move.kind == moveCommit || time.Since(move.lastHit) > gitMoveWindow {
		return moveNone
	}
	if !move.treesLoaded {
		move.treesLoaded = true
		var err error
		if move.fromTree, err = state.checkout.TreeBlobs(move.from.Commit); err == nil {
			move.toTree, err = state.checkout.TreeBlobs(move.to.Commit)
		}
		if err != nil {
			log.Printf("journal: read trees for %s: %v", root.Path, err)
			move.fromTree, move.toTree = nil, nil
		}
	}
	if move.toTree == nil {
		return moveNone
	}
	repoPath := state.checkout.Prefix + relPath
	before, inFrom := move.fromTree[repoPath]
	after, inTo := move.toTree[repoPath]
	wrote := false
	if deleted {
		wrote = inFrom && !inTo
	} else if inTo && before != after {
		wrote = sameBlob(absPath, after)
	}
	if !wrote {
		return moveNone
	}
	move.lastHit = time.Now()
	return move.kind
}

// sameBlob compares a working file with a committed blob, allowing for the
// CRLF a checkout writes on Windows when core.autocrlf is set.
func sameBlob(absPath, blob string) bool {
	content, err := os.ReadFile(absPath)
	return err == nil && gitworktree.ContentMatchesBlob(content, blob)
}

// journalAsGit adapts a file change's journaling to what Git did: quiet for a
// switch, attributed to Git for a pull or reset. The returned function ends
// the quiet scope.
func journalAsGit(sqlDB *sql.DB, root db.Root, relPath, absPath string, deleted bool, actor *string) func() {
	switch gitWrote(sqlDB, root, relPath, absPath, deleted) {
	case moveSwitch:
		return beginQuiet(root.ID, []string{relPath})
	case moveGit:
		*actor = activity.ActorGit
	}
	return func() {}
}
