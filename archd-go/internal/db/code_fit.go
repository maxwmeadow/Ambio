package db

import (
	"database/sql"
	"fmt"
	"path"
	"sort"
	"strings"
)

// Code fit: after a meaning edit says where a file belongs, does the code
// agree? A map decision is free; making the code match it is real work, so
// Axiom only reports the disagreement and offers it as a work order
// (docs/PRODUCT.md §2, WORK `make-code-match`).
//
// Two signals, both deliberately conservative so the offer is rare and right:
//
//   - folder: the system's other files mostly live under one folder and this
//     file does not. Systems that span the tree have no home folder and never
//     report this.
//   - coupling: most of the file's import edges connect to one other system,
//     more than to its own.

const (
	CodeFitFolder   = "folder"
	CodeFitCoupling = "coupling"
)

// CodeFitFinding is one way the code disagrees with where the map puts a file.
type CodeFitFinding struct {
	Kind       string `json:"kind"`
	FileID     string `json:"fileId"`
	FilePath   string `json:"filePath"`
	SystemID   string `json:"systemId"`
	SystemName string `json:"systemName"`
	// folder
	HomeFolder    string `json:"homeFolder,omitempty"`
	SuggestedPath string `json:"suggestedPath,omitempty"`
	// coupling
	OtherSystemID   string   `json:"otherSystemId,omitempty"`
	OtherSystemName string   `json:"otherSystemName,omitempty"`
	OtherEdges      int      `json:"otherEdges,omitempty"`
	TotalEdges      int      `json:"totalEdges,omitempty"`
	OtherFiles      []string `json:"otherFiles,omitempty"`
	// Summary says what disagrees; Ask is the instruction an agent would act on.
	Summary string `json:"summary"`
	Ask     string `json:"ask"`
}

// codeFitFileLimit bounds the work after a large regroup; the offer is about
// the change you just made, not an audit of the project.
const codeFitFileLimit = 200

type fitFile struct {
	id, rootID, relPath string
	systemID            string
}

// CodeFit checks the given files against the systems they now belong to.
// Files with no system, or that no longer exist, are skipped.
func CodeFit(database *sql.DB, workspaceID string, fileIDs []string) ([]CodeFitFinding, error) {
	if len(fileIDs) == 0 {
		return []CodeFitFinding{}, nil
	}
	if len(fileIDs) > codeFitFileLimit {
		fileIDs = fileIDs[:codeFitFileLimit]
	}
	systems, err := fitSystems(database, workspaceID)
	if err != nil {
		return nil, err
	}
	files, err := fitFiles(database, workspaceID)
	if err != nil {
		return nil, err
	}
	byID := map[string]fitFile{}
	for _, f := range files {
		byID[f.id] = f
	}
	edges, err := fitImports(database, workspaceID, fileIDs)
	if err != nil {
		return nil, err
	}

	findings := []CodeFitFinding{}
	seen := map[string]bool{}
	for _, id := range fileIDs {
		file, ok := byID[id]
		if !ok || file.systemID == "" || seen[id] {
			continue
		}
		seen[id] = true
		system := systems[file.systemID]
		if system == nil {
			continue
		}
		if finding, ok := folderFit(file, system, systems, files); ok {
			findings = append(findings, finding)
		}
		if finding, ok := couplingFit(file, system, systems, byID, edges[id]); ok {
			findings = append(findings, finding)
		}
	}
	return findings, nil
}

func fitSystems(database *sql.DB, workspaceID string) (map[string]*System, error) {
	rows, err := database.Query(`SELECT id, name, parent_id FROM systems WHERE workspace_id = ?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*System{}
	for rows.Next() {
		var system System
		var parent sql.NullString
		if err := rows.Scan(&system.ID, &system.Name, &parent); err != nil {
			return nil, err
		}
		system.ParentID = nullableString(parent)
		out[system.ID] = &system
	}
	return out, rows.Err()
}

func fitFiles(database *sql.DB, workspaceID string) ([]fitFile, error) {
	rows, err := database.Query(`
		SELECT f.id, f.root_id, f.rel_path, COALESCE(f.system_id, '')
		FROM files f JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id = ?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []fitFile{}
	for rows.Next() {
		var f fitFile
		if err := rows.Scan(&f.id, &f.rootID, &f.relPath, &f.systemID); err != nil {
			return nil, err
		}
		f.relPath = strings.ReplaceAll(f.relPath, `\`, "/")
		out = append(out, f)
	}
	return out, rows.Err()
}

// fitImports returns, for each given file, the files it imports or is
// imported by (one entry per edge).
func fitImports(database *sql.DB, workspaceID string, fileIDs []string) (map[string][]string, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(fileIDs)), ",")
	args := []any{workspaceID}
	for _, id := range fileIDs {
		args = append(args, id)
	}
	args = append(args, args[1:]...)
	rows, err := database.Query(`
		SELECT src, dst FROM dependencies
		WHERE workspace_id = ? AND src_type = 'file' AND dst_type = 'file'
		  AND dependency_type = 'IMPORTS' AND status != 'dismissed'
		  AND (src IN (`+placeholders+`) OR dst IN (`+placeholders+`))`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	wanted := map[string]bool{}
	for _, id := range fileIDs {
		wanted[id] = true
	}
	out := map[string][]string{}
	for rows.Next() {
		var src, dst string
		if err := rows.Scan(&src, &dst); err != nil {
			return nil, err
		}
		if src == dst {
			continue
		}
		if wanted[src] {
			out[src] = append(out[src], dst)
		}
		if wanted[dst] {
			out[dst] = append(out[dst], src)
		}
	}
	return out, rows.Err()
}

// inSubtree reports whether systemID is root or nested anywhere inside it.
func inSubtree(systems map[string]*System, systemID, root string) bool {
	for hops := 0; systemID != "" && hops < 64; hops++ {
		if systemID == root {
			return true
		}
		system := systems[systemID]
		if system == nil || system.ParentID == nil {
			return false
		}
		systemID = *system.ParentID
	}
	return false
}

// homeFolder is the deepest folder holding at least two thirds of the given
// paths, or "" when only the project root does.
func homeFolder(paths []string) string {
	if len(paths) < 2 {
		return ""
	}
	counts := map[string]int{}
	for _, p := range paths {
		for dir := path.Dir(p); dir != "." && dir != "/" && dir != ""; dir = path.Dir(dir) {
			counts[dir]++
		}
	}
	best := ""
	for dir, count := range counts {
		if count*3 < len(paths)*2 {
			continue
		}
		if strings.Count(dir, "/") > strings.Count(best, "/") || best == "" ||
			(strings.Count(dir, "/") == strings.Count(best, "/") && dir < best) {
			best = dir
		}
	}
	return best
}

func folderFit(file fitFile, system *System, systems map[string]*System, files []fitFile) (CodeFitFinding, bool) {
	others := []string{}
	for _, other := range files {
		if other.id == file.id || other.rootID != file.rootID || other.systemID == "" {
			continue
		}
		if inSubtree(systems, other.systemID, system.ID) {
			others = append(others, other.relPath)
		}
	}
	home := homeFolder(others)
	if home == "" || strings.HasPrefix(file.relPath, home+"/") {
		return CodeFitFinding{}, false
	}
	suggested := home + "/" + path.Base(file.relPath)
	return CodeFitFinding{
		Kind: CodeFitFolder, FileID: file.id, FilePath: file.relPath,
		SystemID: system.ID, SystemName: system.Name,
		HomeFolder: home, SuggestedPath: suggested,
		Summary: fmt.Sprintf("%s belongs to %s, but the rest of %s is in %s/", path.Base(file.relPath), system.Name, system.Name, home),
		Ask: fmt.Sprintf("Move %s to %s and update every import of it. Keep its behavior unchanged.",
			file.relPath, suggested),
	}, true
}

func couplingFit(
	file fitFile, system *System, systems map[string]*System, byID map[string]fitFile, neighbours []string,
) (CodeFitFinding, bool) {
	own := 0
	foreign := map[string][]string{}
	for _, id := range neighbours {
		other, ok := byID[id]
		if !ok || other.systemID == "" {
			continue
		}
		switch {
		case inSubtree(systems, other.systemID, system.ID):
			own++
		case inSubtree(systems, system.ID, other.systemID):
			// An enclosing system's shared code is neither home nor away.
		default:
			foreign[other.systemID] = append(foreign[other.systemID], other.relPath)
		}
	}
	total := own
	topID := ""
	for id, paths := range foreign {
		total += len(paths)
		if topID == "" || len(paths) > len(foreign[topID]) || (len(paths) == len(foreign[topID]) && id < topID) {
			topID = id
		}
	}
	if topID == "" {
		return CodeFitFinding{}, false
	}
	top := len(foreign[topID])
	if total < 3 || top < 2 || top <= own || top*2 <= total {
		return CodeFitFinding{}, false
	}
	other := systems[topID]
	otherFiles := uniqueSorted(foreign[topID])
	name := path.Base(file.relPath)
	return CodeFitFinding{
		Kind: CodeFitCoupling, FileID: file.id, FilePath: file.relPath,
		SystemID: system.ID, SystemName: system.Name,
		OtherSystemID: topID, OtherSystemName: other.Name,
		OtherEdges: top, TotalEdges: total, OtherFiles: otherFiles,
		Summary: fmt.Sprintf("%s belongs to %s, but %d of its %d imports connect to %s", name, system.Name, top, total, other.Name),
		Ask: fmt.Sprintf("%s now belongs to %s, but it is still tied to %s (%s). "+
			"Refactor so it depends on %s only through a small interface, or move the %s-specific parts back into %s.",
			file.relPath, system.Name, other.Name, strings.Join(otherFiles, ", "), other.Name, other.Name, other.Name),
	}, true
}

func uniqueSorted(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}
