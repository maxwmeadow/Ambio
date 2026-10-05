package db

import "strings"

// SymbolHit is one symbol found by name, with the file it lives in.
type SymbolHit struct {
	Symbol
	RelPath string `json:"relPath"`
}

// SearchSymbols finds symbols whose name contains query (case-insensitive)
// across a workspace: exact names first, then names starting with it, then the
// rest, shorter names first within each. This is what ⌘K and the Model
// Explorer search; agents have the same lookup as search_symbols.
func SearchSymbols(r Reader, workspaceID, query string, limit int) ([]SymbolHit, error) {
	query = strings.TrimSpace(query)
	out := []SymbolHit{}
	if query == "" {
		return out, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	lower := strings.ToLower(query)
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(lower)
	rows, err := r.Query(`
		SELECT s.id, s.file_id, s.name, s.kind, s.line_start, s.line_end, f.rel_path
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		JOIN roots ro ON ro.id = f.root_id
		WHERE ro.workspace_id = ? AND lower(s.name) LIKE ? ESCAPE '\'
		ORDER BY CASE WHEN lower(s.name) = ? THEN 0 WHEN lower(s.name) LIKE ? ESCAPE '\' THEN 1 ELSE 2 END,
			length(s.name), s.name, f.rel_path, s.line_start
		LIMIT ?`, workspaceID, "%"+escaped+"%", lower, escaped+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var hit SymbolHit
		if err := rows.Scan(&hit.ID, &hit.FileID, &hit.Name, &hit.Kind, &hit.LineStart, &hit.LineEnd, &hit.RelPath); err != nil {
			return nil, err
		}
		out = append(out, hit)
	}
	return out, rows.Err()
}
