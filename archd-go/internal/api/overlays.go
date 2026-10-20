package api

import (
	"os"
	"path"
	"path/filepath"
	"sort"
	"sync"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
	"ambio.local/archd/internal/indexer"
)

// Another checkout's work, drawn on the Floor without indexing that checkout
// (docs/GIT_AND_PROJECT_SHAPES.md "One map, many checkouts"): only the files
// it changes against its merge base with the Floor's checkout, each tied to
// the Floor file it changes or, for a new file, the system its folder
// belongs to.

const (
	overlayAdded    = "added"
	overlayModified = "modified"
	overlayDeleted  = "deleted"
)

type overlayFile struct {
	Path   string `json:"path"`
	Change string `json:"change"`
	// FileID is the Floor file this changes or deletes.
	FileID string `json:"fileId,omitempty"`
	// SystemID is where the file lives on the Floor, or for a new file the
	// system that owns most of its folder.
	SystemID string `json:"systemId,omitempty"`
}

// overlayFileLimit keeps a checkout that rewrote the world (a mass rename, a
// vendored drop) from flooding the map; the count still says how many.
const overlayFileLimit = 400

var (
	treeCacheMu sync.Mutex
	treeCache   = map[string]map[string]string{}
	treeOrder   []string
)

// cachedTree lists a commit's blobs once; commits never change.
func cachedTree(checkout gitworktree.Checkout, commit string) (map[string]string, error) {
	key := checkout.CommonDir + "@" + commit
	treeCacheMu.Lock()
	tree, ok := treeCache[key]
	treeCacheMu.Unlock()
	if ok {
		return tree, nil
	}
	tree, err := checkout.TreeBlobs(commit)
	if err != nil {
		return nil, err
	}
	treeCacheMu.Lock()
	defer treeCacheMu.Unlock()
	if _, exists := treeCache[key]; !exists {
		treeCache[key] = tree
		treeOrder = append(treeOrder, key)
		if len(treeOrder) > 8 {
			delete(treeCache, treeOrder[0])
			treeOrder = treeOrder[1:]
		}
	}
	return tree, nil
}

// folderSystems answers "which system owns this folder" for a new file: the
// system holding most of the folder's Floor files, or of the nearest folder
// above that has any.
type folderSystems map[string]map[string]int

func newFolderSystems(files []db.File) folderSystems {
	folders := folderSystems{}
	for _, file := range files {
		if file.SystemID == nil || *file.SystemID == "" {
			continue
		}
		folder := path.Dir(filepath.ToSlash(file.RelPath))
		if folders[folder] == nil {
			folders[folder] = map[string]int{}
		}
		folders[folder][*file.SystemID]++
	}
	return folders
}

func (folders folderSystems) owner(relPath string) string {
	for folder := path.Dir(relPath); ; folder = path.Dir(folder) {
		best, bestCount := "", 0
		for systemID, count := range folders[folder] {
			if count > bestCount || (count == bestCount && systemID < best) {
				best, bestCount = systemID, count
			}
		}
		if best != "" || folder == "." || folder == "/" {
			return best
		}
	}
}

// checkoutOverlay is what root changes against its merge base with the Floor's
// checkout. truncated reports how many files were left out past the limit.
func checkoutOverlay(focused db.Root, floorFiles []db.File, root db.Root) (files []overlayFile, truncated int, err error) {
	if headStateOf(root) == headUnborn || headStateOf(focused) == headUnborn ||
		headStateOf(root) == headNone || headStateOf(focused) == headNone {
		return []overlayFile{}, 0, nil
	}
	base, err := gitworktree.MergeBase(root.Path, focused.HeadCommit, root.HeadCommit)
	if err != nil {
		return nil, 0, err
	}
	checkout, err := gitworktree.Locate(root.Path)
	if err != nil {
		return nil, 0, err
	}
	tree, err := cachedTree(checkout, base)
	if err != nil {
		return nil, 0, err
	}
	changed, err := gitworktree.ChangedSince(root.Path, base)
	if err != nil {
		return nil, 0, err
	}

	byPath := make(map[string]db.File, len(floorFiles))
	for _, file := range floorFiles {
		byPath[filepath.ToSlash(file.RelPath)] = file
	}
	folders := newFolderSystems(floorFiles)
	files = []overlayFile{}
	for _, relPath := range changed {
		if !indexer.InScope(root, relPath) {
			continue
		}
		blob, inBase := tree[checkout.Prefix+relPath]
		absPath := filepath.Join(root.Path, filepath.FromSlash(relPath))
		_, statErr := os.Stat(absPath)
		onDisk := statErr == nil
		entry := overlayFile{Path: relPath}
		switch {
		case inBase && !onDisk:
			entry.Change = overlayDeleted
		case !inBase && onDisk:
			entry.Change = overlayAdded
		case inBase && onDisk:
			content, readErr := os.ReadFile(absPath)
			if readErr == nil && gitworktree.ContentMatchesBlob(content, blob) {
				continue // touched, then put back
			}
			entry.Change = overlayModified
		default:
			continue
		}
		if floor, ok := byPath[relPath]; ok {
			entry.FileID = floor.ID
			if floor.SystemID != nil {
				entry.SystemID = *floor.SystemID
			}
		} else {
			entry.SystemID = folders.owner(relPath)
		}
		files = append(files, entry)
	}
	sort.Slice(files, func(left, right int) bool { return files[left].Path < files[right].Path })
	if len(files) > overlayFileLimit {
		truncated = len(files) - overlayFileLimit
		files = files[:overlayFileLimit]
	}
	return files, truncated, nil
}
