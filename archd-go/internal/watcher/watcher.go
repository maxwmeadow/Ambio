// Package watcher uses fsnotify to detect source file changes and trigger re-indexing.
package watcher

import (
	"database/sql"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	"ambio.local/archd/internal/indexer"
	"ambio.local/archd/internal/infradetect"
)

var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, ".idea": true, ".vscode": true,
	"dist": true, "build": true, "out": true, ".next": true,
	"__pycache__": true, "vendor": true, "target": true,
}

const (
	fileChangeDebounce     = 150 * time.Millisecond
	burstMaxWait           = 2 * time.Second
	classificationDebounce = 1500 * time.Millisecond
)

// Watcher wraps fsnotify and debounces rapid file saves.
type Watcher struct {
	fw           *fsnotify.Watcher
	sqlDB        *sql.DB
	h            *hub.Hub
	rootsMu      sync.RWMutex
	roots        []db.Root
	pendingMu    sync.Mutex
	pending      map[string]struct{}
	burst        *time.Timer
	burstStarted time.Time
	// flushMu keeps bursts in order: one is indexed before the next begins.
	flushMu sync.Mutex
	// batchBroadcast marks roots whose last burst was indexed as a batch,
	// which sends no per-file patches: the canvas learns of it at settle.
	batchBroadcast   map[string]bool
	classificationMu sync.Mutex
	classifications  map[string]*time.Timer
	reclusterMu      sync.Mutex
	closed           atomic.Bool
	// onSettled runs after a burst of changes has been indexed and classified
	// - the moment derived views (infra detection) should catch up.
	settledMu sync.RWMutex
	onSettled func(db.Root)
}

// OnSettled registers what runs once a burst of changes has settled.
func (w *Watcher) OnSettled(fn func(db.Root)) {
	w.settledMu.Lock()
	w.onSettled = fn
	w.settledMu.Unlock()
}

// UpdateRoot refreshes branch/HEAD metadata without tearing down filesystem
// watches. Scheduled callbacks take a copy, so each event is stamped with the
// newest identity available when its path is resolved.
func (w *Watcher) UpdateRoot(updated db.Root) {
	w.rootsMu.Lock()
	defer w.rootsMu.Unlock()
	for index := range w.roots {
		if w.roots[index].ID == updated.ID {
			w.roots[index] = updated
			return
		}
	}
}

// New creates a Watcher and adds all root paths recursively.
func New(sqlDB *sql.DB, h *hub.Hub, roots []db.Root) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		fw:              fw,
		sqlDB:           sqlDB,
		h:               h,
		roots:           roots,
		pending:         make(map[string]struct{}),
		batchBroadcast:  make(map[string]bool),
		classifications: make(map[string]*time.Timer),
	}
	for _, root := range roots {
		if err := addRecursive(fw, root.Path, root.IgnoredPaths); err != nil {
			log.Printf("watcher: add %s: %v", root.Path, err)
			if IsWatchLimit(err) {
				// Live updates would silently stop for part of the tree. Say so,
				// with the fix, instead of leaving a map that quietly goes stale.
				h.Broadcast("watcher:limited", map[string]any{
					"workspaceId": root.WorkspaceID,
					"rootPath":    root.Path,
					"reason":      err.Error(),
				})
			}
		}
	}
	return w, nil
}

// IsWatchLimit reports the OS refusing more watches: Linux's inotify
// max_user_watches ("no space left on device") or the open-file limit.
func IsWatchLimit(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no space left on device") || strings.Contains(message, "too many open files")
}

// Run starts the event loop. Call in a goroutine; returns when Close() is called.
func (w *Watcher) Run() {
	for {
		select {
		case event, ok := <-w.fw.Events:
			if !ok {
				return
			}
			// A directory that appears after startup (e.g. an agent scaffolding
			// src/components/) must start being watched, and any files created
			// alongside it indexed - fsnotify does not recurse into directories
			// added after the initial watch was established.
			if event.Op&fsnotify.Create != 0 {
				if fi, err := os.Stat(event.Name); err == nil && fi.IsDir() {
					w.watchNewDir(event.Name)
					continue
				}
			}
			if !isSourceFile(event.Name) {
				// Manifests, env examples, compose and platform files are not
				// source, but infra detection reads them.
				if root := w.rootFor(event.Name); root != nil {
					if rel, err := filepath.Rel(root.Path, event.Name); err == nil && infradetect.WantsConfig(filepath.ToSlash(rel)) {
						w.scheduleClassification(*root)
					}
				}
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
				continue
			}
			w.scheduleChange(filepath.Clean(event.Name))

		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			log.Printf("watcher: error: %v", err)
		}
	}
}

// Close shuts down the fsnotify watcher.
func (w *Watcher) Close() error {
	w.closed.Store(true)

	w.pendingMu.Lock()
	if w.burst != nil {
		w.burst.Stop()
	}
	w.pending = make(map[string]struct{})
	w.pendingMu.Unlock()

	w.classificationMu.Lock()
	for rootID, timer := range w.classifications {
		timer.Stop()
		delete(w.classifications, rootID)
	}
	w.classificationMu.Unlock()

	return w.fw.Close()
}

// scheduleChange adds a path to the current burst. A burst is indexed once
// writes pause for fileChangeDebounce, or after burstMaxWait of continuous
// writing.
func (w *Watcher) scheduleChange(absPath string) {
	if w.closed.Load() {
		return
	}
	w.pendingMu.Lock()
	defer w.pendingMu.Unlock()
	if len(w.pending) == 0 {
		w.burstStarted = time.Now()
	}
	w.pending[absPath] = struct{}{}
	wait := fileChangeDebounce
	if remaining := burstMaxWait - time.Since(w.burstStarted); remaining < wait {
		wait = max(remaining, 0)
	}
	if w.burst == nil {
		w.burst = time.AfterFunc(wait, w.flush)
	} else {
		w.burst.Reset(wait)
	}
}

func (w *Watcher) flush() {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	w.pendingMu.Lock()
	paths := w.pending
	w.pending = make(map[string]struct{})
	w.pendingMu.Unlock()
	if w.closed.Load() || len(paths) == 0 {
		return
	}
	byRoot := map[string][]string{}
	roots := map[string]db.Root{}
	for path := range paths {
		if root := w.rootFor(path); root != nil {
			byRoot[root.ID] = append(byRoot[root.ID], path)
			roots[root.ID] = *root
		}
	}
	for id, list := range byRoot {
		sort.Strings(list)
		w.handleBurst(roots[id], list)
	}
}

// handleBurst indexes one root's share of a burst. A few files are an edit:
// each is indexed on its own and animates. Many files, or any while Git is
// moving the checkout (a switch, pull or rebase writes files in waves), are
// indexed as one batch (indexer.ReindexBatch).
func (w *Watcher) handleBurst(root db.Root, paths []string) {
	if len(paths) < indexer.BatchThreshold && !indexer.CheckoutMoving(w.sqlDB, root) {
		for _, path := range paths {
			w.handleChange(path)
		}
		return
	}
	var changed, removed []string
	for _, path := range paths {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			removed = append(removed, path)
		} else {
			changed = append(changed, path)
		}
	}
	log.Printf("watcher: %d files changed together in %s", len(paths), root.Path)
	if _, err := indexer.ReindexBatch(w.sqlDB, w.h, root, changed, removed); err != nil {
		log.Printf("watcher: batch %s: %v", root.Path, err)
	}
	w.classificationMu.Lock()
	w.batchBroadcast[root.ID] = true
	w.classificationMu.Unlock()
	w.scheduleClassification(root)
}

func (w *Watcher) handleChange(absPath string) {
	if w.closed.Load() {
		return
	}
	root := w.rootFor(absPath)
	if root == nil {
		return
	}
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		log.Printf("watcher: removed %s", absPath)
		if err := indexer.RemoveFile(w.sqlDB, w.h, *root, absPath); err != nil {
			log.Printf("watcher: remove %s: %v", absPath, err)
			return
		}
		w.scheduleClassification(*root)
		return
	}
	log.Printf("watcher: changed %s", absPath)
	if err := indexer.ReindexFile(w.sqlDB, w.h, *root, absPath); err != nil {
		log.Printf("watcher: reindex %s: %v", absPath, err)
		return
	}
	w.scheduleClassification(*root)
}

// scheduleClassification waits for the entire write burst to settle. Files
// still materialize immediately through file:updated patches; only their
// architectural organization is batched, avoiding a camera/layout churn for
// every file an agent writes.
func (w *Watcher) scheduleClassification(root db.Root) {
	if w.closed.Load() {
		return
	}
	w.classificationMu.Lock()
	defer w.classificationMu.Unlock()

	if timer, exists := w.classifications[root.ID]; exists {
		timer.Stop()
		timer.Reset(classificationDebounce)
		return
	}
	w.classifications[root.ID] = time.AfterFunc(classificationDebounce, func() {
		w.classificationMu.Lock()
		delete(w.classifications, root.ID)
		w.classificationMu.Unlock()
		if w.closed.Load() {
			return
		}
		w.runClassification(root)
	})
}

func (w *Watcher) runClassification(root db.Root) {
	if w.closed.Load() {
		return
	}
	// SQLite already serializes writes, but keeping the expensive planning pass
	// single-flight prevents two roots from racing snapshots and event order.
	w.reclusterMu.Lock()
	defer w.reclusterMu.Unlock()

	changed, err := indexer.ClusterLive(w.sqlDB, root)
	w.settledMu.RLock()
	settled := w.onSettled
	w.settledMu.RUnlock()
	if settled != nil {
		defer settled(root)
	}
	w.classificationMu.Lock()
	batched := w.batchBroadcast[root.ID]
	delete(w.batchBroadcast, root.ID)
	w.classificationMu.Unlock()
	if err != nil {
		log.Printf("watcher: live classification %s: %v", root.Path, err)
		if !batched {
			return
		}
	}
	if !changed && !batched {
		return
	}
	snapshot, err := db.GetCanvasSnapshot(w.sqlDB, root.WorkspaceID)
	if err != nil {
		log.Printf("watcher: classification snapshot %s: %v", root.Path, err)
		return
	}
	w.h.BroadcastClassification(snapshot)
}

// watchNewDir begins watching a directory that appeared after startup and
// indexes any source files already inside it. Files written in the same instant
// the directory is created never fire their own Create event (the watch isn't
// attached yet), so we scan once; later edits reindex idempotently.
func (w *Watcher) watchNewDir(dir string) {
	root := w.rootFor(dir)
	if root == nil {
		return
	}
	name := filepath.Base(dir)
	if skipDirs[name] || strings.HasPrefix(name, ".") {
		return
	}
	if err := addRecursive(w.fw, dir, root.IgnoredPaths); err != nil {
		log.Printf("watcher: watch new dir %s: %v", dir, err)
	}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if isIgnoredPath(p, root.IgnoredPaths) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if isSourceFile(p) {
			// Part of the burst: a checkout that adds folders adds many files.
			w.scheduleChange(filepath.Clean(p))
		}
		return nil
	})
}

func (w *Watcher) rootFor(absPath string) *db.Root {
	w.rootsMu.RLock()
	defer w.rootsMu.RUnlock()
	for i, r := range w.roots {
		if strings.HasPrefix(absPath, filepath.Clean(r.Path)+string(filepath.Separator)) {
			if isIgnoredPath(absPath, r.IgnoredPaths) {
				return nil
			}
			root := w.roots[i]
			return &root
		}
	}
	return nil
}

// addRecursive watches path and all non-skipped, source-boundary-approved
// subdirectories.
func addRecursive(fw *fsnotify.Watcher, path string, ignoredPaths []string) error {
	return filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if isIgnoredPath(p, ignoredPaths) {
			return filepath.SkipDir
		}
		name := filepath.Base(p)
		if skipDirs[name] || strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}
		return fw.Add(p)
	})
}

func isIgnoredPath(path string, ignoredPaths []string) bool {
	cleanPath := filepath.Clean(path)
	for _, ignored := range ignoredPaths {
		cleanIgnored := filepath.FromSlash(ignored)
		cleanIgnored = strings.TrimSuffix(cleanIgnored, string(filepath.Separator)+"**")
		cleanIgnored = strings.TrimSuffix(cleanIgnored, "/**")
		cleanIgnored = filepath.Clean(cleanIgnored)
		relative, err := filepath.Rel(cleanIgnored, cleanPath)
		if err != nil {
			continue
		}
		if relative == "." || (relative != ".." &&
			!strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
			return true
		}
	}
	return false
}

func isSourceFile(path string) bool {
	return indexer.IsSupportedSourceFile(path)
}
