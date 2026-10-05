package db

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// Work-order code checks. A "make the code match" work order carries the
// disagreements it was sent to fix (code_fit.go). Ambio re-checks them against
// the indexed code whenever the order is read, so whether the code now agrees
// is something Ambio verified, not something the agent reported.

const (
	CodeCheckAgrees     = "agrees"
	CodeCheckDisagrees  = "disagrees"
	CodeCheckMapChanged = "map-changed" // the file is no longer in that system; nothing to verify
	CodeCheckFileGone   = "file-gone"
)

// CodeCheckResult is one sent disagreement and where it stands now.
type CodeCheckResult struct {
	Sent  CodeFitFinding `json:"sent"`
	State string         `json:"state"`
	// Now describes the current state in one sentence.
	Now string `json:"now"`
}

func migrateCodeChecks(d *sql.DB) error {
	_, err := d.Exec(`
	CREATE TABLE IF NOT EXISTS work_order_code_checks (
		message_id TEXT PRIMARY KEY REFERENCES canvas_outbox(id) ON DELETE CASCADE,
		findings   TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`)
	return err
}

// SaveWorkOrderCodeChecks freezes what a work order was sent to fix. A retried
// send keeps the first record.
func SaveWorkOrderCodeChecks(d *sql.DB, messageID string, findings []CodeFitFinding) error {
	if len(findings) == 0 {
		return nil
	}
	encoded, err := json.Marshal(findings)
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT OR IGNORE INTO work_order_code_checks (message_id, findings, created_at) VALUES (?,?,?)`,
		messageID, string(encoded), time.Now().UnixMilli())
	return err
}

// WorkOrderCodeChecks re-checks the frozen disagreements of the given work
// orders against the code as indexed now. Orders without checks are absent.
func WorkOrderCodeChecks(d *sql.DB, workspaceID string, messageIDs []string) (map[string][]CodeCheckResult, error) {
	out := map[string][]CodeCheckResult{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(messageIDs)), ",")
	args := []any{workspaceID}
	for _, id := range messageIDs {
		args = append(args, id)
	}
	rows, err := d.Query(`
		SELECT c.message_id, c.findings FROM work_order_code_checks c
		JOIN canvas_outbox m ON m.id = c.message_id
		WHERE m.workspace_id = ? AND c.message_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	sent := map[string][]CodeFitFinding{}
	order := []string{}
	for rows.Next() {
		var id, encoded string
		if err := rows.Scan(&id, &encoded); err != nil {
			rows.Close()
			return nil, err
		}
		var findings []CodeFitFinding
		if json.Unmarshal([]byte(encoded), &findings) == nil && len(findings) > 0 {
			sent[id] = findings
			order = append(order, id)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(sent) == 0 {
		return out, nil
	}

	// Where each file is now, and what still disagrees about it.
	current := map[string]*fitPlacement{}
	for _, findings := range sent {
		for _, finding := range findings {
			current[finding.FileID] = nil
		}
	}
	fileIDs := make([]string, 0, len(current))
	for id := range current {
		fileIDs = append(fileIDs, id)
	}
	if err := loadPlacements(d, workspaceID, fileIDs, current); err != nil {
		return nil, err
	}
	still, err := CodeFit(d, workspaceID, fileIDs)
	if err != nil {
		return nil, err
	}
	stillByKey := map[string]CodeFitFinding{}
	for _, finding := range still {
		stillByKey[finding.FileID+"\x00"+finding.Kind] = finding
	}

	for _, id := range order {
		for _, finding := range sent[id] {
			result := CodeCheckResult{Sent: finding}
			placement := current[finding.FileID]
			switch {
			case placement == nil:
				result.State = CodeCheckFileGone
				result.Now = finding.FilePath + " no longer exists"
			case placement.systemID != finding.SystemID:
				result.State = CodeCheckMapChanged
				result.Now = placement.relPath + " is no longer in " + finding.SystemName + " on the map"
			default:
				if now, disagrees := stillByKey[finding.FileID+"\x00"+finding.Kind]; disagrees {
					result.State = CodeCheckDisagrees
					result.Now = now.Summary
				} else {
					result.State = CodeCheckAgrees
					result.Now = agreesSentence(finding, placement.relPath)
				}
			}
			out[id] = append(out[id], result)
		}
	}
	return out, nil
}

type fitPlacement struct {
	relPath, systemID string
}

func loadPlacements(d *sql.DB, workspaceID string, fileIDs []string, into map[string]*fitPlacement) error {
	if len(fileIDs) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(fileIDs)), ",")
	args := []any{workspaceID}
	for _, id := range fileIDs {
		args = append(args, id)
	}
	rows, err := d.Query(`
		SELECT f.id, f.rel_path, COALESCE(f.system_id, '') FROM files f JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id = ? AND f.id IN (`+placeholders+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		placement := &fitPlacement{}
		if err := rows.Scan(&id, &placement.relPath, &placement.systemID); err != nil {
			return err
		}
		into[id] = placement
	}
	return rows.Err()
}

func agreesSentence(finding CodeFitFinding, relPath string) string {
	if finding.Kind == CodeFitFolder {
		return relPath + " now lives with the rest of " + finding.SystemName
	}
	return relPath + " no longer depends mostly on " + finding.OtherSystemName
}
