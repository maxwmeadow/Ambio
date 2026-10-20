package api

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/gitworktree"
	"ambio.local/archd/internal/indexer"
)

type rootOpenOptions struct {
	IgnoredPaths               []string
	SourceBoundariesReviewedAt *int64
}

// gitAppearsPoll is how often a project that is not a Git checkout checks
// whether it has become one.
const gitAppearsPoll = 2 * time.Second

type worktreeMonitor struct {
	cancel context.CancelFunc
	done   chan struct{}
	// resync asks the monitor to reconcile worktrees now (a focus change).
	resync chan struct{}
}

type pendingRootSync struct {
	root      db.Root
	fullIndex bool
}

func normalizedRootPath(path string) string {
	return normalizedRootPathForOS(resolvedRootPath(path), runtime.GOOS)
}

// resolvedRootPath canonicalizes a path through any symlinks along the way.
//
// macOS is why this exists: /tmp and /var are themselves symlinks into
// /private, so Git reports "/private/var/..." for a worktree the caller opened
// as "/var/...". Compared literally those look like two different roots, and
// the worktree's watcher is never registered. A path that does not exist yet
// cannot be resolved and keeps its literal form.
func resolvedRootPath(path string) string {
	if path == "" {
		return path
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

func normalizedRootPathForOS(path, goos string) string {
	normalized := filepath.ToSlash(filepath.Clean(path))
	if goos == "windows" || goos == "darwin" {
		// filepath follows the running host, while tests and persisted metadata
		// can contain Windows separators on another host.
		normalized = strings.ReplaceAll(normalized, `\`, "/")
		// Both hosts are case-insensitive by default - Windows always, macOS
		// because APFS and HFS+ are unless deliberately formatted otherwise.
		// Linux is case-sensitive and must keep distinct roots distinct.
		return strings.ToLower(normalized)
	}
	return normalized
}

func sameRootPath(left, right string) bool {
	return normalizedRootPath(left) == normalizedRootPath(right)
}

func sameOptionalInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func stableRootID(workspaceID, path string) string {
	sum := sha256.Sum256([]byte(workspaceID + "|" + normalizedRootPath(path)))
	return hex.EncodeToString(sum[:])[:32]
}

func ignoredPathsForWorktree(patterns []string, requestedRoot, targetRoot string) []string {
	requested := strings.TrimSuffix(filepath.ToSlash(filepath.Clean(requestedRoot)), "/")
	target := strings.TrimSuffix(filepath.ToSlash(filepath.Clean(targetRoot)), "/")
	translated := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		normalized := filepath.ToSlash(pattern)
		if len(normalized) >= len(requested) &&
			sameRootPath(normalized[:len(requested)], requested) &&
			(len(normalized) == len(requested) || normalized[len(requested)] == '/') {
			normalized = target + normalized[len(requested):]
		}
		translated = append(translated, normalized)
	}
	return translated
}

func (s *Server) discoverInitialWorktrees(rootPath string) ([]gitworktree.Worktree, bool) {
	worktrees, err := s.discoverWorktrees(rootPath)
	if err == nil {
		return worktrees, true
	}
	log.Printf("api: %v; using the requested folder as a single root", err)
	return []gitworktree.Worktree{{Path: filepath.Clean(rootPath), Primary: true}}, false
}

func canonicalGraphRoot(requestedPath, focusedPath string, worktrees []gitworktree.Worktree) (gitworktree.Worktree, bool) {
	// A checkout someone chose to show on the Floor wins while it exists.
	for _, worktree := range worktrees {
		if focusedPath != "" && sameRootPath(worktree.Path, focusedPath) {
			return worktree, true
		}
	}
	for _, worktree := range worktrees {
		if sameRootPath(worktree.Path, requestedPath) {
			return worktree, true
		}
	}
	for _, worktree := range worktrees {
		if worktree.Primary {
			return worktree, true
		}
	}
	if len(worktrees) > 0 {
		return worktrees[0], true
	}
	return gitworktree.Worktree{}, false
}

// narrowLegacyProjection moves a project opened at a folder inside a
// repository onto that folder when its map is still indexed at the
// repository's top level, as every such project was until October 2026. The
// folder's files keep their identity - systems, layout, history - and the
// rest of the repository leaves the map quietly (db.NarrowRootProjection).
// It returns the root the projection moved to, if it moved.
func (s *Server) narrowLegacyProjection(
	sqlDB *sql.DB,
	workspaceID string,
	existingByPath map[string]db.Root,
	canonical gitworktree.Worktree,
	options rootOpenOptions,
) (string, error) {
	if canonical.TopLevel == "" || sameRootPath(canonical.TopLevel, canonical.Path) {
		return "", nil
	}
	if _, opened := existingByPath[normalizedRootPath(canonical.Path)]; opened {
		return "", nil
	}
	whole, known := existingByPath[normalizedRootPath(canonical.TopLevel)]
	if !known || !whole.IsActive || whole.IndexedAt == nil || *whole.IndexedAt == 0 {
		return "", nil
	}
	prefix, err := filepath.Rel(canonical.TopLevel, canonical.Path)
	if err != nil {
		return "", err
	}
	prefix = filepath.ToSlash(prefix) + "/"
	folder := db.Root{
		ID:                         stableRootID(workspaceID, canonical.Path),
		WorkspaceID:                workspaceID,
		Path:                       filepath.Clean(canonical.Path),
		Branch:                     canonical.Branch,
		HeadCommit:                 canonical.HeadCommit,
		IsPrimary:                  canonical.Primary,
		IsActive:                   true,
		IgnoredPaths:               options.IgnoredPaths,
		SourceBoundariesReviewedAt: options.SourceBoundariesReviewedAt,
	}
	if folder.IgnoredPaths == nil {
		folder.IgnoredPaths, folder.SourceBoundariesReviewedAt = whole.IgnoredPaths, whole.SourceBoundariesReviewedAt
	}
	if err := db.UpsertRoot(sqlDB, folder); err != nil {
		return "", err
	}
	s.stopWatcher(whole.ID)
	kept, dropped, err := db.NarrowRootProjection(sqlDB, whole, folder, prefix)
	if err != nil {
		return "", fmt.Errorf("move the map onto %s: %w", canonical.Path, err)
	}
	log.Printf("api: the map moved onto %s (%d files kept, %d outside it left the map)", canonical.Path, kept, dropped)
	folder.IndexedAt, folder.ClassifierVersion = whole.IndexedAt, whole.ClassifierVersion
	existingByPath[normalizedRootPath(canonical.Path)] = folder
	whole.IndexedAt, whole.ClassifierVersion = nil, 0
	existingByPath[normalizedRootPath(whole.Path)] = whole
	return folder.ID, nil
}

// followCanonicalProjection keeps the one projection on the canonical
// checkout. When the Floor moves to another checkout (a focus change, or the
// focused worktree being removed), the file rows move with it rather than
// being dropped and re-indexed, so systems, layout and history keep their
// files. It returns the ID of the root the projection moved to, if it moved.
func (s *Server) followCanonicalProjection(
	sqlDB *sql.DB,
	existing []db.Root,
	existingByPath map[string]db.Root,
	canonicalPath string,
) (string, error) {
	target, known := existingByPath[normalizedRootPath(canonicalPath)]
	if !known {
		return "", nil
	}
	if count, err := db.CountFilesByRoot(sqlDB, target.ID); err != nil || count > 0 {
		return "", err
	}
	for _, source := range existing {
		if source.ID == target.ID {
			continue
		}
		count, err := db.CountFilesByRoot(sqlDB, source.ID)
		if err != nil {
			return "", err
		}
		if count == 0 {
			continue
		}
		s.stopWatcher(source.ID)
		target.Path = filepath.Clean(canonicalPath)
		movedFiles, err := db.MoveRootProjection(sqlDB, source, target)
		if err != nil {
			return "", fmt.Errorf("move the Floor from %s to %s: %w", source.Path, target.Path, err)
		}
		log.Printf("api: the Floor moved from %s to %s (%d files)", source.Path, target.Path, movedFiles)
		target.IndexedAt, target.ClassifierVersion = source.IndexedAt, source.ClassifierVersion
		existingByPath[normalizedRootPath(canonicalPath)] = target
		source.IndexedAt, source.ClassifierVersion = nil, 0
		existingByPath[normalizedRootPath(source.Path)] = source
		return target.ID, nil
	}
	return "", nil
}

// syncWorkspaceWorktrees keeps exactly one filesystem projection in the graph.
// Linked Git worktrees describe parallel branches; indexing each as another root
// duplicates every source file and corrupts system counts and classification.
// Their branch metadata remains discoverable through Git, while only the folder
// the user opened (or the primary worktree fallback) owns live file rows.
func (s *Server) syncWorkspaceWorktrees(
	sqlDB *sql.DB,
	workspaceID string,
	requestedPath string,
	worktrees []gitworktree.Worktree,
	options rootOpenOptions,
	scheduleIndex bool,
	reconcileExisting bool,
) (string, error) {
	existing, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil {
		return "", err
	}
	existingByPath := make(map[string]db.Root, len(existing))
	for _, root := range existing {
		existingByPath[normalizedRootPath(root.Path)] = root
	}
	focusedPath := ""
	for _, root := range existing {
		if root.IsFocused && root.IsActive {
			focusedPath = root.Path
		}
	}
	canonical, ok := canonicalGraphRoot(requestedPath, focusedPath, worktrees)
	if !ok {
		return "", fmt.Errorf("no filesystem root discovered for %s", requestedPath)
	}
	moved, err := s.narrowLegacyProjection(sqlDB, workspaceID, existingByPath, canonical, options)
	if err != nil {
		return "", err
	}
	if moved == "" {
		moved, err = s.followCanonicalProjection(sqlDB, existing, existingByPath, canonical.Path)
		if err != nil {
			return "", err
		}
	}

	activeIDs := make(map[string]struct{}, len(worktrees))
	requestedRootID := ""
	rootsChanged := reconcileExisting || moved != ""
	topologyChanged := reconcileExisting || moved != ""
	canonicalPath := filepath.Clean(canonical.Path)
	for _, discovered := range worktrees {
		path := filepath.Clean(discovered.Path)
		prior, known := existingByPath[normalizedRootPath(path)]
		root := db.Root{
			ID:          stableRootID(workspaceID, path),
			WorkspaceID: workspaceID,
			Path:        path,
			Branch:      discovered.Branch,
			HeadCommit:  discovered.HeadCommit,
			IsPrimary:   discovered.Primary,
			IsActive:    true,
			IgnoredPaths: ignoredPathsForWorktree(
				options.IgnoredPaths,
				requestedPath,
				path,
			),
			SourceBoundariesReviewedAt: options.SourceBoundariesReviewedAt,
		}
		if known {
			root.ID = prior.ID
			root.IndexedAt = prior.IndexedAt
			root.ClassifierVersion = prior.ClassifierVersion
			if options.SourceBoundariesReviewedAt == nil && prior.SourceBoundariesReviewedAt != nil {
				root.IgnoredPaths = prior.IgnoredPaths
				root.SourceBoundariesReviewedAt = prior.SourceBoundariesReviewedAt
			}
		}
		isCanonical := sameRootPath(path, canonicalPath)
		if isCanonical {
			// The journal compares HEAD with the commit last indexed, so a branch
			// switched while Ambio was closed is not caught up as edits.
			seed := gitworktree.Head{Branch: root.Branch, Commit: root.HeadCommit}
			if known {
				seed = gitworktree.Head{Branch: prior.Branch, Commit: prior.HeadCommit}
			}
			indexer.SeedHead(root.ID, seed)
		}
		rootChanged := !known || !prior.IsActive || prior.Branch != root.Branch ||
			prior.HeadCommit != root.HeadCommit || prior.IsPrimary != root.IsPrimary ||
			!slices.Equal(prior.IgnoredPaths, root.IgnoredPaths) ||
			!sameOptionalInt64(prior.SourceBoundariesReviewedAt, root.SourceBoundariesReviewedAt)
		if rootChanged {
			if err := db.UpsertRoot(sqlDB, root); err != nil {
				return "", fmt.Errorf("register worktree %s: %w", path, err)
			}
			rootsChanged = true
			if !known || !prior.IsActive || prior.IsPrimary != root.IsPrimary {
				topologyChanged = true
			}
		}
		activeIDs[root.ID] = struct{}{}
		if sameRootPath(path, requestedPath) {
			requestedRootID = root.ID
		}
		if isCanonical {
			if known && (prior.HeadCommit != root.HeadCommit || prior.Branch != root.Branch) {
				indexer.NoteHead(sqlDB, root)
			}
			s.startWatcher(sqlDB, root)
		} else {
			s.stopWatcher(root.ID)
			removed, err := db.ClearRootGraphProjection(sqlDB, root.ID)
			if err != nil {
				return "", fmt.Errorf("clear linked worktree projection %s: %w", path, err)
			}
			if removed > 0 {
				log.Printf("api: removed %d duplicate file rows for linked worktree %s", removed, path)
				topologyChanged = true
			}
		}

		if !scheduleIndex || !isCanonical {
			continue
		}
		indexed := root.IndexedAt != nil && *root.IndexedAt > 0
		headChanged := known && prior.HeadCommit != root.HeadCommit
		switch {
		case moved == root.ID:
			// The Floor moved here from another checkout: same files, another
			// branch. Catch the projection up without journaling it.
			s.mu.Lock()
			s.rootQuietReconcile[root.ID] = true
			s.mu.Unlock()
			s.launchRootSync(sqlDB, root, false)
		case !indexed:
			if err := db.DeleteFilesByRoot(sqlDB, root.ID); err != nil {
				return "", fmt.Errorf("clear root %s: %w", path, err)
			}
			s.launchRootSync(sqlDB, root, true)
		case reconcileExisting || headChanged || !prior.IsActive:
			if known && prior.IsActive && !slices.Equal(prior.IgnoredPaths, root.IgnoredPaths) {
				s.mu.Lock()
				// Keep the earliest scope if several changes arrive before a sync runs.
				if _, pending := s.rootScopeFrom[root.ID]; !pending {
					s.rootScopeFrom[root.ID] = prior.IgnoredPaths
				}
				s.mu.Unlock()
			}
			s.launchRootSync(sqlDB, root, false)
		}
	}

	for _, root := range existing {
		if !root.IsActive {
			continue
		}
		if _, remains := activeIDs[root.ID]; remains {
			continue
		}
		s.stopWatcher(root.ID)
		if err := db.DeactivateRoot(sqlDB, root.ID); err != nil {
			return "", fmt.Errorf("deactivate removed worktree %s: %w", root.Path, err)
		}
		log.Printf("api: worktree removed from active roots: %s", root.Path)
		rootsChanged = true
		topologyChanged = true
	}

	if requestedRootID == "" && len(worktrees) > 0 {
		requestedRootID = stableRootID(workspaceID, worktrees[0].Path)
		if prior, ok := existingByPath[normalizedRootPath(worktrees[0].Path)]; ok {
			requestedRootID = prior.ID
		}
	}
	if topologyChanged {
		s.reloadRegistry()
	}
	if rootsChanged {
		s.hub.Broadcast("roots:changed", map[string]any{"workspaceId": workspaceID})
	}
	return requestedRootID, nil
}

func (s *Server) launchRootSync(sqlDB *sql.DB, root db.Root, fullIndex bool) {
	s.mu.Lock()
	if s.rootSyncing[root.ID] {
		pending := s.rootSyncPending[root.ID]
		pending.root = root
		pending.fullIndex = pending.fullIndex || fullIndex
		s.rootSyncPending[root.ID] = pending
		s.mu.Unlock()
		return
	}
	s.rootSyncing[root.ID] = true
	s.mu.Unlock()
	done, open := s.startBackground(root.WorkspaceID)
	if !open {
		s.mu.Lock()
		delete(s.rootSyncing, root.ID)
		s.mu.Unlock()
		return
	}

	go func() {
		defer done()
		defer func() {
			s.mu.Lock()
			delete(s.rootSyncing, root.ID)
			_, active := s.roots[root.ID]
			pending, hasPending := s.rootSyncPending[root.ID]
			delete(s.rootSyncPending, root.ID)
			s.mu.Unlock()
			if !active {
				_ = db.DeactivateRoot(sqlDB, root.ID)
			} else if hasPending {
				s.launchRootSync(sqlDB, pending.root, pending.fullIndex)
			}
		}()

		if fullIndex {
			if err := indexer.IndexRoot(sqlDB, s.hub, root, root.IgnoredPaths); err != nil {
				log.Printf("api: index root %s: %v", root.Path, err)
				return
			}
			baselineAt := time.Now().UnixMilli()
			if err := db.SetDeltaReviewedAtForRoot(
				sqlDB, root.WorkspaceID, root.ID, baselineAt,
			); err != nil {
				log.Printf("api: baseline delta watermark for %s/%s: %v", root.WorkspaceID, root.ID, err)
			}
			if _, err := s.saveDeltaSnapshotForRoot(sqlDB, root, baselineAt); err != nil {
				log.Printf("api: baseline delta snapshot for %s/%s: %v", root.WorkspaceID, root.ID, err)
			}
		} else {
			s.mu.Lock()
			scopeFrom, rescope := s.rootScopeFrom[root.ID]
			delete(s.rootScopeFrom, root.ID)
			force := s.rootForceReindex[root.ID]
			delete(s.rootForceReindex, root.ID)
			quiet := s.rootQuietReconcile[root.ID]
			delete(s.rootQuietReconcile, root.ID)
			s.mu.Unlock()
			var err error
			if quiet {
				_, err = indexer.ReconcileRootQuietly(sqlDB, s.hub, root, root.IgnoredPaths)
			} else if force {
				_, err = indexer.ReindexRootInPlace(sqlDB, s.hub, root, root.IgnoredPaths)
			} else if rescope {
				_, err = indexer.ReconcileScope(sqlDB, s.hub, root, scopeFrom, root.IgnoredPaths)
			} else {
				_, err = indexer.ReconcileRoot(sqlDB, s.hub, root, root.IgnoredPaths)
			}
			if err != nil {
				log.Printf("api: reconcile %s: %v", root.Path, err)
			}
			snapshot, _ := db.GetCanvasSnapshot(sqlDB, root.WorkspaceID)
			needsCluster := snapshot != nil && len(snapshot.Files) > 0 &&
				(len(snapshot.Systems) == 0 || root.ClassifierVersion < indexer.ClassifierVersion)
			if needsCluster {
				if err := indexer.ClusterOnly(sqlDB, root); err != nil {
					log.Printf("api: cluster-only %s: %v", root.Path, err)
				}
			}
		}

		if err := indexer.EnsureDetectionEvidence(sqlDB, root); err != nil {
			log.Printf("api: detection evidence %s: %v", root.Path, err)
		}
		s.detectInfra(sqlDB, root)

		snapshot, _ := db.GetCanvasSnapshot(sqlDB, root.WorkspaceID)
		if snapshot != nil {
			s.hub.BroadcastSnapshot(snapshot)
		}
		s.invalidateCollisionCache(root.WorkspaceID)
		s.hub.Broadcast("delta:ready", map[string]any{
			"workspaceId": root.WorkspaceID,
			"rootId":      root.ID,
			"branch":      root.Branch,
		})
	}()
}

func (s *Server) startWorktreeMonitor(
	sqlDB *sql.DB,
	workspaceID string,
	anchorPath string,
	options rootOpenOptions,
) {
	if s.worktreeRefresh <= 0 {
		return
	}
	s.mu.Lock()
	if _, exists := s.worktreeMonitors[workspaceID]; exists {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	resync := make(chan struct{}, 1)
	s.worktreeMonitors[workspaceID] = worktreeMonitor{cancel: cancel, done: done, resync: resync}
	interval := s.worktreeRefresh
	s.mu.Unlock()

	go func() {
		defer close(done)
		var metadata *gitworktree.MetadataWatcher
		var changes <-chan struct{}
		var watchErrors <-chan error
		watch := func() bool {
			watcher, err := gitworktree.WatchMetadata(anchorPath)
			if err != nil {
				return false
			}
			metadata, changes, watchErrors = watcher, watcher.Changes(), watcher.Errors()
			return true
		}
		defer func() {
			if metadata != nil {
				metadata.Close()
			}
		}()
		// A folder that is not a Git checkout yet may become one (`git init`).
		// Checking for .git is a stat; branch tracking starts the moment it
		// appears instead of at the next safety refresh or restart.
		var notGit <-chan time.Time
		if !watch() {
			log.Printf("api: %s is not a Git checkout; watching for one", anchorPath)
			poll := time.NewTicker(gitAppearsPoll)
			defer poll.Stop()
			notGit = poll.C
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// Other checkouts are not watched file by file; their changes reach the
		// Floor's overlays by polling Git here and pushing only differences.
		checkoutPoll := time.NewTicker(s.checkoutPoll)
		defer checkoutPoll.Stop()
		lastCheckouts := ""
		var debounce *time.Timer
		var debounceC <-chan time.Time
		defer func() {
			if debounce != nil {
				debounce.Stop()
			}
		}()
		reconcile := func() {
			worktrees, err := s.discoverWorktrees(anchorPath)
			if err != nil {
				log.Printf("api: refresh worktrees for %s: %v", workspaceID, err)
				return
			}
			if _, err := s.syncWorkspaceWorktrees(
				sqlDB, workspaceID, anchorPath, worktrees, options, true, false,
			); err != nil {
				log.Printf("api: reconcile worktrees for %s: %v", workspaceID, err)
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-changes:
				if !ok {
					changes = nil
					continue
				}
				if debounce == nil {
					debounce = time.NewTimer(200 * time.Millisecond)
				} else {
					if !debounce.Stop() {
						select {
						case <-debounce.C:
						default:
						}
					}
					debounce.Reset(200 * time.Millisecond)
				}
				debounceC = debounce.C
			case <-debounceC:
				debounceC = nil
				reconcile()
			case err, ok := <-watchErrors:
				if !ok {
					watchErrors = nil
					continue
				}
				log.Printf("api: Git metadata watcher for %s: %v", workspaceID, err)
			case <-ticker.C:
				if notGit == nil {
					reconcile()
				}
			case <-resync:
				reconcile()
			case <-checkoutPoll.C:
				lastCheckouts = s.pushCheckoutChanges(sqlDB, workspaceID, lastCheckouts)
			case <-notGit:
				if _, err := os.Stat(filepath.Join(anchorPath, ".git")); err != nil || !watch() {
					continue
				}
				notGit = nil
				log.Printf("api: %s became a Git checkout", anchorPath)
				reconcile()
			}
		}
	}()
}

func (s *Server) handleRoots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, roots)
}

// pushCheckoutChanges rebuilds the checkouts snapshot when the project has
// more than one checkout and announces it if anything changed since last.
func (s *Server) pushCheckoutChanges(sqlDB *sql.DB, workspaceID, last string) string {
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil || len(roots) < 2 {
		return last
	}
	now := time.Now().UnixMilli()
	snapshot, err := s.buildCheckouts(sqlDB, workspaceID, now)
	if err != nil {
		return last
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return last
	}
	fingerprint := string(encoded)
	if fingerprint == last {
		return last
	}
	s.mu.Lock()
	s.checkoutsCache[workspaceID] = checkoutsCacheEntry{
		snapshot: snapshot, expiresAt: now + s.collisionCacheTTL.Milliseconds(),
	}
	s.mu.Unlock()
	if last != "" {
		s.hub.Broadcast("checkouts:changed", map[string]any{"workspaceId": workspaceID})
	}
	return fingerprint
}
