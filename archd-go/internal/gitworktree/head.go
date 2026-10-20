package gitworktree

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Checkout locates one working copy's Git administration. GitDir is private
// to the checkout (a linked worktree's lives under the common directory's
// worktrees/), refs and objects live in CommonDir, and Prefix is the opened
// folder relative to the checkout's top level ("" at the top, otherwise
// slash-terminated, as `git rev-parse --show-prefix` prints it).
type Checkout struct {
	GitDir    string
	CommonDir string
	TopLevel  string
	Prefix    string
}

// Head is what a checkout has checked out. Commit is empty on an unborn
// branch (after `git init`, before the first commit).
type Head struct {
	Branch string
	Commit string
}

// Locate resolves the checkout containing path, or an error when path is not
// inside a Git working tree.
func Locate(path string) (Checkout, error) {
	output, err := gitOutput(path,
		"rev-parse", "--path-format=absolute",
		"--git-dir", "--git-common-dir", "--show-toplevel", "--show-prefix",
	)
	if err != nil {
		return Checkout{}, err
	}
	lines := strings.Split(strings.TrimRight(string(output), "\n"), "\n")
	if len(lines) < 3 {
		return Checkout{}, fmt.Errorf("git rev-parse in %s: unexpected output %q", path, output)
	}
	checkout := Checkout{
		GitDir:    filepath.Clean(filepath.FromSlash(lines[0])),
		CommonDir: filepath.Clean(filepath.FromSlash(lines[1])),
		TopLevel:  filepath.Clean(filepath.FromSlash(lines[2])),
	}
	if len(lines) > 3 {
		checkout.Prefix = filepath.ToSlash(lines[3])
	}
	return checkout, nil
}

// ReadHead reads HEAD straight from the administration files, so it is cheap
// enough to call for every file event. Repositories using the reftable
// backend, or anything unexpected on disk, fall back to asking Git.
func (c Checkout) ReadHead() (Head, error) {
	raw, err := os.ReadFile(filepath.Join(c.GitDir, "HEAD"))
	if err != nil {
		return Head{}, err
	}
	content := strings.TrimSpace(string(raw))
	ref, symbolic := strings.CutPrefix(content, "ref: ")
	if !symbolic {
		return Head{Branch: DetachedBranch, Commit: content}, nil
	}
	head := Head{Branch: strings.TrimPrefix(ref, "refs/heads/")}
	if _, err := os.Stat(filepath.Join(c.CommonDir, "reftable")); err == nil {
		return c.headFromGit(head)
	}
	if raw, err := os.ReadFile(filepath.Join(c.CommonDir, filepath.FromSlash(ref))); err == nil {
		head.Commit = strings.TrimSpace(string(raw))
		return head, nil
	}
	commit, err := packedRef(filepath.Join(c.CommonDir, "packed-refs"), ref)
	if err != nil {
		return Head{}, err
	}
	head.Commit = commit // "" when the branch is unborn
	return head, nil
}

func (c Checkout) headFromGit(head Head) (Head, error) {
	output, err := gitOutput(c.TopLevel, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil {
		// An unborn branch has no commit to verify.
		return head, nil
	}
	head.Commit = strings.TrimSpace(string(output))
	return head, nil
}

func packedRef(path, ref string) (string, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		commit, name, ok := strings.Cut(scanner.Text(), " ")
		if ok && name == ref {
			return commit, nil
		}
	}
	return "", scanner.Err()
}

// Busy reports whether a Git command is rewriting this checkout right now:
// checkout, merge, reset and friends hold index.lock while they write files
// and only move HEAD at the end. A lock older than staleAfter is left over
// from a crashed command and does not count.
func (c Checkout) Busy(staleAfter time.Duration) bool {
	info, err := os.Stat(filepath.Join(c.GitDir, "index.lock"))
	return err == nil && time.Since(info.ModTime()) < staleAfter
}

// HeadMessages returns the reflog messages that took HEAD from one state to
// another, oldest first ("checkout: moving from main to feature", "commit:
// …", "pull: Fast-forward"). It returns nil when the reflog does not cover
// the move (reflogs disabled, expired, or rewritten).
//
// The commit alone does not mark where the move began: `checkout -b` changes
// the branch but not the commit, so the reflog is walked backwards tracking
// which branch HEAD was on, from each "moving from A to B".
func (c Checkout) HeadMessages(from, to Head) []string {
	raw, err := os.ReadFile(filepath.Join(c.GitDir, "logs", "HEAD"))
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	branch := to.Branch
	var messages []string
	for index := len(lines) - 1; index >= 0; index-- {
		identity, message, ok := strings.Cut(lines[index], "\t")
		fields := strings.Fields(identity)
		if !ok || len(fields) < 2 {
			return nil
		}
		old, next := fields[0], fields[1]
		if len(messages) == 0 && next != to.Commit && !(to.Commit == "" && strings.Trim(next, "0") == "") {
			// The newest entry must be the move we are explaining.
			return nil
		}
		messages = append(messages, message)
		if moved, ok := strings.CutPrefix(message, "checkout: moving from "); ok {
			if before, _, ok := strings.Cut(moved, " to "); ok {
				branch = before
				if isObjectName(branch) {
					branch = DetachedBranch
				}
			}
		}
		atFrom := old == from.Commit || (from.Commit == "" && strings.Trim(old, "0") == "")
		if atFrom && branch == from.Branch {
			for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
				messages[left], messages[right] = messages[right], messages[left]
			}
			return messages
		}
	}
	return nil
}

func isObjectName(name string) bool {
	if len(name) != sha1.Size*2 && len(name) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(name)
	return err == nil
}

// TreeBlobs lists every blob in a commit's tree, keyed by path relative to the
// repository's top level. An empty commit (unborn branch) is an empty tree.
func (c Checkout) TreeBlobs(commit string) (map[string]string, error) {
	blobs := map[string]string{}
	if commit == "" {
		return blobs, nil
	}
	output, err := gitOutput(c.TopLevel, "ls-tree", "-r", "-z", "--full-tree", commit)
	if err != nil {
		return nil, err
	}
	for _, record := range bytes.Split(output, []byte{0}) {
		meta, path, ok := bytes.Cut(record, []byte{'\t'})
		if !ok {
			continue
		}
		fields := strings.Fields(string(meta))
		if len(fields) == 3 && fields[1] == "blob" {
			blobs[string(path)] = fields[2]
		}
	}
	return blobs, nil
}

// BlobID is the object name Git gives content. like is any object name from
// the same repository, so SHA-256 repositories hash the same way Git does.
func BlobID(content []byte, like string) string {
	hash := sha1.New()
	if len(like) == sha256.Size*2 {
		hash = sha256.New()
	}
	hash.Write([]byte("blob " + strconv.Itoa(len(content)) + "\x00"))
	hash.Write(content)
	return hex.EncodeToString(hash.Sum(nil))
}
