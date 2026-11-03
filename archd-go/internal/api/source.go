// Function body extraction - serves the source code of an indexed symbol.
//
//	GET /api/function-body?workspace=<id>&file=<fileId|relPath>&symbol=<name>
//
// The file may be referenced by ID or by relative path (suffix match allowed,
// forward or back slashes). The symbol is matched exactly first, then
// case-insensitively. Returns every match - overloaded/duplicate names in the
// same file are all included so the agent can disambiguate by line range.
package api

import (
	"bufio"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"ambio.local/archd/internal/db"
)

// maxBodyLines caps a single returned function body so a pathological symbol
// (e.g. a 5,000-line class) cannot blow out the agent's context window.
const maxBodyLines = 400

type functionBodyMatch struct {
	Symbol    string `json:"symbol"`
	Kind      string `json:"kind"`
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
	Truncated bool   `json:"truncated,omitempty"`
	Body      string `json:"body"`
}

type fileSourceResponse struct {
	FileID    string `json:"fileId"`
	RelPath   string `json:"relPath"`
	Language  string `json:"language"`
	LineCount int    `json:"lineCount"`
	Content   string `json:"content"`
	// Hash is the SHA-256 of the bytes on disk; a save must name it.
	Hash string `json:"hash"`
	// Editable is false when the bytes are not UTF-8 text, which JSON would
	// alter on the way to the editor and so corrupt on the way back.
	Editable bool `json:"editable"`
}

// maxSourceSave caps one saved file; source larger than this is not edited in Ambio.
const maxSourceSave = 8 << 20

func contentHash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func sourceResponse(file *db.File, content []byte) fileSourceResponse {
	return fileSourceResponse{
		FileID:    file.ID,
		RelPath:   file.RelPath,
		Language:  file.Language,
		LineCount: lineCount(content),
		Content:   string(content),
		Hash:      contentHash(content),
		Editable:  utf8.Valid(content),
	}
}

// handleSaveFileSource writes a person's edit to an indexed file.
//
//	PUT /api/files/<id>/source  {"workspaceId", "content", "baseHash"}
//
// The edit was made against the bytes whose hash is baseHash. If the file has
// changed since (an agent wrote it, or another editor saved), nothing is
// written and 409 returns what is there now, so the person can see it rather
// than overwrite it. Only an existing, indexed file inside its project root is
// written - never a path through a link that leaves the project. The watcher
// reindexes it like any other save.
func (s *Server) handleSaveFileSource(w http.ResponseWriter, r *http.Request, fileID string) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Content     string `json:"content"`
		BaseHash    string `json:"baseHash"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSourceSave+64<<10)).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if body.WorkspaceID == "" || body.BaseHash == "" {
		jsonError(w, "workspaceId and baseHash are required", 400)
		return
	}
	if len(body.Content) > maxSourceSave {
		jsonError(w, "file is too large to save from Ambio", 413)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	file, err := db.FindFileByIDOrPath(sqlDB, body.WorkspaceID, fileID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	// Saving names a file by its ID; a path lookup could match a different file.
	if file == nil || file.ID != fileID {
		jsonError(w, fmt.Sprintf("file %q not found in workspace", fileID), 404)
		return
	}
	if err := insideRoot(sqlDB, body.WorkspaceID, file); err != nil {
		jsonError(w, err.Error(), 403)
		return
	}

	s.sourceSaveMu.Lock()
	defer s.sourceSaveMu.Unlock()
	current, err := os.ReadFile(file.Path)
	if err != nil {
		jsonError(w, fmt.Sprintf("read %s: %v", file.RelPath, err), 500)
		return
	}
	if !utf8.Valid(current) {
		jsonError(w, fmt.Sprintf("%s is not UTF-8 text and cannot be edited in Ambio", file.RelPath), 415)
		return
	}
	if contentHash(current) != body.BaseHash {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":   fmt.Sprintf("%s changed since it was opened", file.RelPath),
			"current": sourceResponse(file, current),
		})
		return
	}
	info, err := os.Stat(file.Path)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	// Written in place, as editors do, so the file keeps its identity and mode.
	if err := os.WriteFile(file.Path, []byte(body.Content), info.Mode().Perm()); err != nil {
		jsonError(w, fmt.Sprintf("write %s: %v", file.RelPath, err), 500)
		return
	}
	jsonOK(w, sourceResponse(file, []byte(body.Content)))
}

// insideRoot reports an error unless the file, with every link resolved, is
// inside its own project root.
func insideRoot(sqlDB *sql.DB, workspaceID string, file *db.File) error {
	roots, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil {
		return err
	}
	for _, root := range roots {
		if root.ID != file.RootID {
			continue
		}
		rootPath, err := filepath.EvalSymlinks(root.Path)
		if err != nil {
			return fmt.Errorf("project folder unavailable: %v", err)
		}
		target, err := filepath.EvalSymlinks(file.Path)
		if err != nil {
			return fmt.Errorf("%s is unavailable: %v", file.RelPath, err)
		}
		rel, err := filepath.Rel(rootPath, target)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return fmt.Errorf("%s resolves outside the project and cannot be saved from Ambio", file.RelPath)
		}
		return nil
	}
	return fmt.Errorf("%s has no project folder", file.RelPath)
}

// handleFileSource returns the complete current contents of an indexed file.
// File resolution remains scoped to the requested workspace, so the renderer
// never receives an arbitrary filesystem read primitive.
func (s *Server) handleFileSource(w http.ResponseWriter, r *http.Request, fileID string) {
	workspaceID := r.URL.Query().Get("workspace")
	if workspaceID == "" {
		jsonError(w, "workspace is required", 400)
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	file, err := db.FindFileByIDOrPath(sqlDB, workspaceID, fileID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if file == nil {
		jsonError(w, fmt.Sprintf("file %q not found in workspace", fileID), 404)
		return
	}
	content, err := os.ReadFile(file.Path)
	if err != nil {
		jsonError(w, fmt.Sprintf("read %s: %v", file.RelPath, err), 500)
		return
	}
	jsonOK(w, sourceResponse(file, content))
}

func lineCount(content []byte) int {
	if len(content) == 0 {
		return 0
	}
	count := 1
	for _, b := range content {
		if b == '\n' {
			count++
		}
	}
	if content[len(content)-1] == '\n' {
		count--
	}
	return count
}

func (s *Server) handleFunctionBody(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	fileRef := r.URL.Query().Get("file")
	symbolName := r.URL.Query().Get("symbol")
	if fileRef == "" || symbolName == "" {
		jsonError(w, "file and symbol are required", 400)
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	file, err := db.FindFileByIDOrPath(sqlDB, workspaceID, fileRef)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if file == nil {
		jsonError(w, fmt.Sprintf("file %q not found in workspace", fileRef), 404)
		return
	}

	symbols, err := db.GetSymbolsByFile(sqlDB, file.ID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	var matches []db.Symbol
	for _, sym := range symbols {
		if sym.Name == symbolName {
			matches = append(matches, sym)
		}
	}
	if len(matches) == 0 {
		for _, sym := range symbols {
			if strings.EqualFold(sym.Name, symbolName) {
				matches = append(matches, sym)
			}
		}
	}
	if len(matches) == 0 {
		names := make([]string, 0, len(symbols))
		for _, sym := range symbols {
			names = append(names, sym.Name)
		}
		jsonError(w, fmt.Sprintf("symbol %q not found in %s. Available symbols: %s",
			symbolName, file.RelPath, strings.Join(names, ", ")), 404)
		return
	}

	// Read only up to the last line any match needs - never the whole file
	// into memory (an indexed file could be a huge generated artifact).
	maxLine := 0
	for _, sym := range matches {
		if sym.LineEnd > maxLine {
			maxLine = sym.LineEnd
		}
		if sym.LineStart+maxBodyLines > maxLine {
			maxLine = sym.LineStart + maxBodyLines
		}
	}
	lines, err := readLines(file.Path, maxLine)
	if err != nil {
		jsonError(w, fmt.Sprintf("read %s: %v", file.Path, err), 500)
		return
	}

	results := make([]functionBodyMatch, 0, len(matches))
	for _, sym := range matches {
		body, truncated := sliceLines(lines, sym.LineStart, sym.LineEnd)
		results = append(results, functionBodyMatch{
			Symbol:    sym.Name,
			Kind:      sym.Kind,
			LineStart: sym.LineStart,
			LineEnd:   sym.LineEnd,
			Truncated: truncated,
			Body:      body,
		})
	}
	jsonOK(w, map[string]any{
		"fileId":  file.ID,
		"relPath": file.RelPath,
		"matches": results,
	})
}

// readLines reads at most maxLine lines from path.
func readLines(path string, maxLine int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	lines := make([]string, 0, 256)
	for len(lines) < maxLine && scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

// sliceLines returns lines start..end (1-indexed, inclusive), clamped to the
// file and capped at maxBodyLines. The index may be stale relative to the file
// on disk, so out-of-range values clamp rather than error.
func sliceLines(lines []string, start, end int) (string, bool) {
	if start < 1 {
		start = 1
	}
	if end < start {
		end = start
	}
	if start > len(lines) {
		return "", false
	}
	if end > len(lines) {
		end = len(lines)
	}
	truncated := false
	if end-start+1 > maxBodyLines {
		end = start + maxBodyLines - 1
		truncated = true
	}
	return strings.Join(lines[start-1:end], "\n"), truncated
}
