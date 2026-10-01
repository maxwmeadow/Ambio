package db

import (
	"database/sql"
	"fmt"
	"time"
)

// Sheet removals: a sheet's third kind of opinion (docs/CANVAS_BEHAVIOR_CONTRACT.md
// "What a sheet is"). Proposing that a live file, system or infrastructure node
// should go away never touches reality; it takes the node out of that sheet's
// picture, stays listed on the sheet until restored, and becomes a requirement
// a work order is checked against: done once the code is gone.
//
// Removals are kept by node ID rather than as sheet elements so they survive
// the node itself being deleted - that is when a removal is realized, and the
// Removed list must still show it.

type SheetRemoval struct {
	SheetID   string `json:"sheetId"`
	NodeID    string `json:"nodeId"`
	NodeType  string `json:"nodeType"` // file | system | infra
	Label     string `json:"label"`
	CreatedBy string `json:"createdBy"` // user | agent
	CreatedAt int64  `json:"createdAt"`
	// Done is true once the node has left the code (see removalPending).
	Done bool `json:"done"`
}

func migrateSheetRemovals(d *sql.DB) error {
	_, err := d.Exec(`
	CREATE TABLE IF NOT EXISTS sheet_removals (
		sheet_id   TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		node_id    TEXT NOT NULL,
		node_type  TEXT NOT NULL,
		label      TEXT NOT NULL,
		created_by TEXT NOT NULL DEFAULT 'user',
		created_at INTEGER NOT NULL,
		PRIMARY KEY (sheet_id, node_id)
	);
	CREATE TRIGGER IF NOT EXISTS sheet_removal_insert_revision AFTER INSERT ON sheet_removals BEGIN
		UPDATE sheets SET revision = revision + 1 WHERE id = NEW.sheet_id; END;
	CREATE TRIGGER IF NOT EXISTS sheet_removal_delete_revision AFTER DELETE ON sheet_removals BEGIN
		UPDATE sheets SET revision = revision + 1 WHERE id = OLD.sheet_id; END;`)
	return err
}

// ProposeSheetRemoval marks a live node for removal on a sheet. Proposing the
// same node twice is a no-op.
func ProposeSheetRemoval(d *sql.DB, workspaceID, sheetID, nodeID, createdBy string) (*SheetRemoval, error) {
	sheet, err := GetSheet(d, sheetID)
	if err != nil {
		return nil, err
	}
	if sheet == nil || sheet.WorkspaceID != workspaceID {
		return nil, sql.ErrNoRows
	}
	nodeType, label, err := liveNodeIdentity(d, workspaceID, nodeID)
	if err != nil {
		return nil, err
	}
	if createdBy != "agent" {
		createdBy = "user"
	}
	if _, err := d.Exec(`
		INSERT OR IGNORE INTO sheet_removals (sheet_id, node_id, node_type, label, created_by, created_at)
		VALUES (?,?,?,?,?,?)`, sheetID, nodeID, nodeType, label, createdBy, time.Now().UnixMilli()); err != nil {
		return nil, err
	}
	removals, err := GetSheetRemovals(d, workspaceID, sheetID)
	if err != nil {
		return nil, err
	}
	for i := range removals {
		if removals[i].NodeID == nodeID {
			return &removals[i], nil
		}
	}
	return nil, sql.ErrNoRows
}

// RestoreSheetRemoval takes a removal back off the sheet.
func RestoreSheetRemoval(d *sql.DB, workspaceID, sheetID, nodeID string) error {
	result, err := d.Exec(`
		DELETE FROM sheet_removals WHERE sheet_id = ? AND node_id = ?
		AND EXISTS (SELECT 1 FROM sheets WHERE id = ? AND workspace_id = ?)`, sheetID, nodeID, sheetID, workspaceID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetSheetRemovals lists a sheet's removals, oldest first, each marked done
// when its node has left the code.
func GetSheetRemovals(r Reader, workspaceID, sheetID string) ([]SheetRemoval, error) {
	rows, err := r.Query(`
		SELECT sheet_id, node_id, node_type, label, created_by, created_at
		FROM sheet_removals WHERE sheet_id = ? ORDER BY created_at, node_id`, sheetID)
	if err != nil {
		return nil, err
	}
	out := []SheetRemoval{}
	for rows.Next() {
		var removal SheetRemoval
		if err := rows.Scan(&removal.SheetID, &removal.NodeID, &removal.NodeType, &removal.Label,
			&removal.CreatedBy, &removal.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, removal)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	live, files, err := loadLiveStructure(r, workspaceID)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Done = !removalPending(live, files, out[i].NodeID, out[i].NodeType)
	}
	return out, nil
}

// removalPending reports whether the code a removal asks to go away is still
// there. A file or infrastructure node is gone when it is no longer indexed;
// a system's code is gone when no file remains in it or below it (the empty
// grouping itself is the map's business, not the code's).
func removalPending(live map[string]StructureNode, files []File, nodeID, nodeType string) bool {
	node, exists := live[nodeID]
	if !exists {
		return false
	}
	if nodeType != "system" || node.Type != "system" {
		return true
	}
	for _, file := range files {
		for system := refValue(file.SystemID); system != ""; system = live[system].ParentID {
			if system == nodeID {
				return true
			}
			if live[system].Type != "system" {
				break
			}
		}
	}
	return false
}

func liveNodeIdentity(r Reader, workspaceID, nodeID string) (nodeType, label string, err error) {
	err = r.QueryRow(`
		SELECT 'file', f.rel_path FROM files f JOIN roots ro ON ro.id = f.root_id WHERE f.id = ? AND ro.workspace_id = ?
		UNION ALL SELECT 'system', name FROM systems WHERE id = ? AND workspace_id = ?
		UNION ALL SELECT 'infra', name FROM infra_nodes WHERE id = ? AND workspace_id = ?
		LIMIT 1`, nodeID, workspaceID, nodeID, workspaceID, nodeID, workspaceID).Scan(&nodeType, &label)
	if err == sql.ErrNoRows {
		return "", "", fmt.Errorf("%w: %s is not a live file, system or infrastructure node in this project", sql.ErrNoRows, nodeID)
	}
	return nodeType, label, err
}
