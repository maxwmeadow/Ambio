package db

import "database/sql"

// FileAuthor is one hand that changed a file: a person ("human", no session)
// or an agent's work session, with when it last did.
type FileAuthor struct {
	Actor     string `json:"actor"`
	SessionID string `json:"sessionId,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Goal      string `json:"goal,omitempty"`
	LastAt    int64  `json:"lastAt"`
	Saves     int    `json:"saves"`
}

// FileAuthorsSince lists who changed a file after sinceMs, newest first, from
// the structural journal. It knows files, not lines: which of a file's
// changed lines each author wrote is not recorded.
func FileAuthorsSince(sqlDB *sql.DB, workspaceID, fileID string, sinceMs int64) ([]FileAuthor, error) {
	rows, err := sqlDB.Query(`
		SELECT e.actor, e.session_id, COALESCE(w.agent, ''), COALESCE(w.goal, ''), MAX(e.ts), SUM(MAX(e.count, 1))
		FROM structural_events e
		LEFT JOIN work_sessions w ON w.id = e.session_id AND e.session_id != ''
		WHERE e.workspace_id = ? AND e.subject_id = ? AND e.ts > ?
		  AND e.kind IN (?, ?)
		GROUP BY e.actor, e.session_id
		ORDER BY MAX(e.ts) DESC`,
		workspaceID, fileID, sinceMs, EventFileCreated, EventFileUpdated)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	authors := []FileAuthor{}
	for rows.Next() {
		var author FileAuthor
		if err := rows.Scan(&author.Actor, &author.SessionID, &author.Agent, &author.Goal, &author.LastAt, &author.Saves); err != nil {
			return nil, err
		}
		authors = append(authors, author)
	}
	return authors, rows.Err()
}
