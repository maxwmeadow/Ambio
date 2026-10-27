package indexer

import (
	"database/sql"
	"log"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"ambio.local/archd/internal/activity"
	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	"ambio.local/archd/internal/parser"
)

// BatchThreshold is how many files changing together make a batch. Below it
// each file is reindexed on its own and animates on the canvas, as an edit
// being typed should; at or above it the change is a checkout, a pull or a
// generator, and is brought in at once.
const BatchThreshold = 8

// ReindexBatch brings many changed and removed files up to date together: a
// branch switch, a pull, a catch-up after Ambio was closed. ReindexFile
// rebuilds the project's imports and call graph and diffs every relationship
// for each file it is given, so a checkout of thousands of files cost
// thousands of whole-project passes (and as many canvas animations). Here
// each file is read once and the project is rebuilt once. Each change is
// journaled as ReindexFile journals it, Git's quietly; the canvas gets one
// reconciliation at the end instead of a replay of every file.
func ReindexBatch(sqlDB *sql.DB, h *hub.Hub, root db.Root, changed, removed []string) (int, error) {
	defer lockRoot(root.ID)()
	started := time.Now()
	traceID := nextLivingTraceID()
	existing, err := buildExistingMap(sqlDB, root.ID)
	if err != nil {
		return 0, err
	}
	beforeDeps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		return 0, err
	}
	beforeCalls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		return 0, err
	}
	// Labels for removed files are read while their rows still exist.
	labeler := newSystemLabeler(sqlDB, root)
	var finish []func()
	defer func() {
		for _, done := range finish {
			done()
		}
	}()
	// Parsed together up front, and again by nothing: the project graph
	// reuses these parses.
	var resolved []string
	for _, absPath := range changed {
		if !awaitingResolution(absPath) {
			resolved = append(resolved, absPath)
		}
	}
	changed = resolved
	parsed := parseFiles(changed, func(absPath string) string { return relativeTo(root, absPath) })
	count := 0
	// Files a person (or agent) changed, as opposed to Git; and whether Git
	// switched branches, whose changes are not journaled at all.
	personal := map[string]bool{}
	switched := false
	touched := map[string]struct{}{}

	for _, absPath := range removed {
		relPath := relativeTo(root, absPath)
		file, known := existing[relPath]
		if !known {
			continue
		}
		systemID, systemName := labeler.systemOf(file.ID)
		actor := activity.ActorFor(root.WorkspaceID)
		move := gitWrote(sqlDB, root, relPath, absPath, true)
		finish = append(finish, journalForMove(move, root, relPath, &actor))
		switched = switched || move == moveSwitch
		personal[file.ID] = move == moveNone
		moveMu.Lock()
		rememberRemoval(root.ID, file)
		err := db.DeleteFileByID(sqlDB, file.ID)
		moveMu.Unlock()
		if err != nil {
			log.Printf("indexer: batch remove %s: %v", relPath, err)
			continue
		}
		delete(existing, relPath)
		journalFileDeleted(sqlDB, root, systemID, systemName, &file, actor, traceID)
		count++
	}

	for _, absPath := range changed {
		if fileTooLarge(absPath) || strings.Contains(strings.ToLower(filepath.Base(absPath)), ".min.") {
			continue
		}
		relPath := relativeTo(root, absPath)
		movedFrom := ""
		var movedSystemID *string
		if _, known := existing[relPath]; !known {
			moveMu.Lock()
			if moved, from, ok := adoptMovedFile(sqlDB, root, relPath, absPath, existing); ok {
				movedFrom, movedSystemID = from, moved.SystemID
				delete(existing, from)
				existing[relPath] = moved
			}
			moveMu.Unlock()
		}
		var prev *db.File
		var prevSyms []db.Symbol
		if p, ok := existing[relPath]; ok {
			prev = &p
			prevSyms, _ = db.GetSymbolsByFile(sqlDB, p.ID)
		}
		result := parsed[absPath]
		if result == nil {
			continue
		}
		if err := indexParsedFile(sqlDB, root, relPath, absPath, result, existing, nil); err != nil {
			log.Printf("indexer: batch index %s: %v", relPath, err)
			continue
		}
		if movedFrom != "" {
			restoreMovedSystem(sqlDB, existing[relPath].ID, movedSystemID)
		}
		file, err := db.GetFileByRelPath(sqlDB, root.ID, relPath)
		if err != nil || file == nil {
			continue
		}
		existing[relPath] = *file
		newSyms, _ := db.GetSymbolsByFile(sqlDB, file.ID)
		move := gitWrote(sqlDB, root, relPath, absPath, false)
		actor, contentChanged := recordActivity(sqlDB, root.WorkspaceID, prev, prevSyms, file, absPath, move != moveNone)
		for key := range changedSymbolTouches(file.ID, prevSyms, newSyms, contentChanged) {
			touched[key] = struct{}{}
		}
		if !contentChanged && prev != nil && movedFrom == "" {
			continue
		}
		if actor == "" {
			actor = activity.ActorFor(root.WorkspaceID)
		}
		finish = append(finish, journalForMove(move, root, relPath, &actor))
		switched = switched || move == moveSwitch
		personal[file.ID] = move == moveNone
		switch {
		case movedFrom != "":
			journalFileMoved(sqlDB, root, labeler, file, movedFrom, actor, traceID)
		case prev == nil:
			journalFileChange(sqlDB, root, labeler, file, db.EventFileCreated, actor, traceID)
		default:
			journalFileChange(sqlDB, root, labeler, file, db.EventFileUpdated, actor, traceID)
		}
		count++
	}
	if count == 0 {
		return 0, nil
	}

	if err := rebuildProjectGraph(sqlDB, root, parsed, beforeDeps); err != nil {
		log.Printf("indexer: batch rebuild graph for %s: %v", root.Path, err)
	}
	afterDeps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		return count, err
	}
	afterCalls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		return count, err
	}
	relationships := diffRelationshipChanges(beforeDeps, afterDeps, beforeCalls, afterCalls, touched)
	// A relationship is a person's when it touches a file they changed. The
	// rest changed only because Git rewrote other files: quiet for a branch
	// switch, Git's for a pull or reset.
	var theirs, gits []RelationshipChange
	for _, relationship := range relationships {
		if personal[relationship.Src] || personal[relationship.Dst] {
			theirs = append(theirs, relationship)
		} else {
			gits = append(gits, relationship)
		}
	}
	// A fresh labeler: relationships name files the batch created.
	relabeler := newSystemLabeler(sqlDB, root)
	journalRelationships(sqlDB, root, relabeler, theirs, activity.ActorFor(root.WorkspaceID), traceID)
	if !switched {
		journalRelationships(sqlDB, root, relabeler, gits, activity.ActorGit, traceID)
	}
	if changed, err := db.ReconcilePlanned(sqlDB, root.WorkspaceID); err == nil {
		for _, p := range changed {
			h.BroadcastPatch(map[string]any{"workspaceId": root.WorkspaceID, "type": "planned:upserted", "payload": p})
		}
	}
	log.Printf("[indexer] batch of %d files in %s: %d relationship changes in %v", count, root.Path, len(relationships), time.Since(started).Round(time.Millisecond))
	return count, nil
}

var rootLocks sync.Map // root ID → *sync.Mutex

// lockRoot serializes changes to one root's map. The watcher indexes a
// burst while a reconcile (a branch switch moves HEAD, which starts one)
// walks the same files: run together, both inserted the same new files and
// each saw the other's rows vanish.
func lockRoot(rootID string) func() {
	lock, _ := rootLocks.LoadOrStore(rootID, &sync.Mutex{})
	mutex := lock.(*sync.Mutex)
	mutex.Lock()
	return mutex.Unlock
}

func relativeTo(root db.Root, absPath string) string {
	relPath, _ := filepath.Rel(root.Path, absPath)
	return filepath.ToSlash(relPath)
}

// parseFiles parses files in parallel, keyed by absolute path. A file that
// cannot be parsed (Git deleted it after the walk) is left out.
func parseFiles(paths []string, relPath func(string) string) map[string]*parser.Result {
	results := make([]*parser.Result, len(paths))
	jobs := make(chan int)
	var wait sync.WaitGroup
	for worker := 0; worker < runtime.GOMAXPROCS(0); worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := range jobs {
				result, err := parser.ParseFile(paths[index], relPath(paths[index]))
				if err != nil {
					log.Printf("indexer: parse skips %s: %v", relPath(paths[index]), err)
					continue
				}
				results[index] = result
			}
		}()
	}
	for index := range paths {
		jobs <- index
	}
	close(jobs)
	wait.Wait()
	parsed := make(map[string]*parser.Result, len(paths))
	for index, result := range results {
		if result != nil {
			parsed[paths[index]] = result
		}
	}
	return parsed
}

// rebuildProjectGraph rebuilds every file's imports and the project's call
// graph from one parse of each file: what buildImportDependencies and
// rebuildAllCallGraph do with a parse each, one file after another. Files in
// parsed are not parsed again, and a file whose imports are those in before
// is not rewritten: after a checkout most files import what they did.
func rebuildProjectGraph(sqlDB *sql.DB, root db.Root, parsed map[string]*parser.Result, before []db.Dependency) error {
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	var unparsed []string
	for _, file := range files {
		if parsed[file.Path] == nil {
			unparsed = append(unparsed, file.Path)
		}
	}
	relPaths := make(map[string]string, len(files))
	for _, file := range files {
		relPaths[file.Path] = file.RelPath
	}
	for absPath, result := range parseFiles(unparsed, func(absPath string) string { return relPaths[absPath] }) {
		parsed[absPath] = result
	}
	// Each import of a file counts once in its edge's weight.
	current := map[string]map[string]int{}
	for _, dependency := range before {
		if dependency.CreatedBy != "parser" {
			continue
		}
		if current[dependency.Src] == nil {
			current[dependency.Src] = map[string]int{}
		}
		current[dependency.Src][dependency.Dst] += dependency.Weight
	}

	relToID := buildImportPathIndex(files)
	csIndex := buildCSharpIndex(files)
	var rawCalls sync.Map
	for _, file := range files {
		result := parsed[file.Path]
		if result == nil {
			continue
		}
		var targets []string
		if strings.HasSuffix(strings.ToLower(file.RelPath), ".cs") {
			targets = csIndex.links(file.ID)
		} else {
			targets = importTargets(file, result, relToID)
		}
		if !sameTargets(current[file.ID], targets) {
			if err := writeImportTargets(sqlDB, root, file, targets); err != nil {
				log.Printf("indexer: dependencies for %s: %v", file.RelPath, err)
			}
		}
		rawCalls.Store(file.ID, result.Calls)
	}
	return buildCallGraph(sqlDB, root, &rawCalls)
}

func sameTargets(current map[string]int, targets []string) bool {
	counts := make(map[string]int, len(targets))
	for _, id := range targets {
		counts[id]++
	}
	if len(counts) != len(current) {
		return false
	}
	for id, count := range counts {
		if current[id] != count {
			return false
		}
	}
	return true
}
