package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Mapping is a finite onboarding task, not an agent work session. The draft,
// submission receipt and process settlement have one durable identity.
type MappingAttempt struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	RootID      string   `json:"rootId"`
	MessageID   string   `json:"messageId,omitempty"`
	State       string   `json:"state"`
	ProposalID  string   `json:"proposalId,omitempty"`
	Notes       []string `json:"notes"`
	StartedAt   int64    `json:"startedAt"`
	SubmittedAt int64    `json:"submittedAt,omitempty"`
	EndedAt     int64    `json:"endedAt,omitempty"`
	TokenHash   string   `json:"-"`
	SystemCount int      `json:"systemCount"`
}

const mappingColumns = `id,workspace_id,root_id,message_id,state,proposal_id,notes,started_at,submitted_at,ended_at,token_hash`

func GetMappingAttempt(database *sql.DB, workspaceID, id string) (*MappingAttempt, error) {
	m := &MappingAttempt{}
	var notes string
	err := database.QueryRow(`SELECT `+mappingColumns+` FROM mapping_attempts WHERE workspace_id=? AND id=?`, workspaceID, id).Scan(&m.ID, &m.WorkspaceID, &m.RootID, &m.MessageID, &m.State, &m.ProposalID, &notes, &m.StartedAt, &m.SubmittedAt, &m.EndedAt, &m.TokenHash)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(notes), &m.Notes); err != nil {
		return nil, err
	}
	if m.ProposalID != "" {
		if err := database.QueryRow(`SELECT COUNT(*) FROM architecture_proposal_systems WHERE proposal_id=? AND revision=1`, m.ProposalID).Scan(&m.SystemCount); err != nil {
			return nil, err
		}
	} else {
		draft, err := GetArchitectureProposalDraft(database, id, workspaceID)
		if err == nil && draft != nil {
			m.SystemCount = len(draft.Systems)
		}
	}
	return m, nil
}

// Unsettled attempts are recovery receipts, including launches interrupted
// before a child process or conversation could be registered.
func ListUnsettledMappingAttempts(database *sql.DB, workspaceID string) ([]*MappingAttempt, error) {
	rows, err := database.Query(`SELECT id FROM mapping_attempts WHERE workspace_id=? AND ended_at=0 ORDER BY started_at`, workspaceID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	result := make([]*MappingAttempt, 0, len(ids))
	for _, id := range ids {
		m, err := GetMappingAttempt(database, workspaceID, id)
		if err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, nil
}

func StartMappingAttempt(database *sql.DB, workspaceID, rootID, id, messageID, tokenHash string) (*MappingAttempt, error) {
	if id == "" || tokenHash == "" {
		return nil, fmt.Errorf("mapping identity is required")
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var root string
	if err = tx.QueryRow(`SELECT id FROM roots WHERE workspace_id=? AND (?='' OR id=?) ORDER BY is_primary DESC LIMIT 1`, workspaceID, rootID, rootID).Scan(&root); err != nil {
		return nil, err
	}
	if messageID != "" {
		var mode, status string
		if err = tx.QueryRow(`SELECT mode,status FROM canvas_outbox WHERE workspace_id=? AND id=?`, workspaceID, messageID).Scan(&mode, &status); err != nil {
			return nil, err
		}
		if mode != "propose" || status != "queued" {
			return nil, fmt.Errorf("mapping request must be a queued proposal")
		}
	}
	now := time.Now().UnixMilli()
	if _, err = tx.Exec(`INSERT INTO architecture_proposal_drafts(id,workspace_id,rationale,created_at,updated_at) VALUES(?,?,'',?,?)`, id, workspaceID, now, now); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`INSERT INTO mapping_attempts(id,workspace_id,root_id,message_id,token_hash,started_at) VALUES(?,?,?,?,?,?)`, id, workspaceID, root, messageID, tokenHash, now); err != nil {
		return nil, fmt.Errorf("another mapping session has not stopped yet: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return GetMappingAttempt(database, workspaceID, id)
}

// Notes and the rationale are accepted only before submission, under the same
// write lock as submit/cancel. They never open a general work session.
func NoteMappingAttempt(database *sql.DB, workspaceID, id, note, rationale string) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = mappingActiveTx(tx, workspaceID, id); err != nil {
		return err
	}
	if strings.TrimSpace(note) != "" {
		if len(note) > 8000 {
			return fmt.Errorf("mapping note is too long")
		}
		if _, err = tx.Exec(`UPDATE mapping_attempts SET notes=json_insert(notes,'$[#]',?) WHERE id=?`, note, id); err != nil {
			return err
		}
	}
	if rationale != "" {
		if _, err = tx.Exec(`UPDATE architecture_proposal_drafts SET rationale=?,updated_at=? WHERE id=?`, rationale, time.Now().UnixMilli(), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ResetMappingDraft clears every chunk an active mapping attempt has drafted,
// keeping the attempt and its notes. A mapping draft cannot be aborted (only
// its attempt can be stopped) and a stored chunk cannot be re-sent with other
// systems, so this is how an agent starts its map over before submitting.
func ResetMappingDraft(database *sql.DB, workspaceID, id string) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = mappingActiveTx(tx, workspaceID, id); err != nil {
		return err
	}
	result, err := tx.Exec(`UPDATE architecture_proposal_drafts SET updated_at=? WHERE id=? AND workspace_id=? AND status='open'`, time.Now().UnixMilli(), id, workspaceID)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed != 1 {
		return fmt.Errorf("mapping draft is not open")
	}
	if _, err = tx.Exec(`DELETE FROM architecture_proposal_draft_chunks WHERE draft_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

func mappingActiveTx(tx *sql.Tx, workspaceID, id string) error {
	var state string
	if err := tx.QueryRow(`SELECT state FROM mapping_attempts WHERE workspace_id=? AND id=?`, workspaceID, id).Scan(&state); err != nil {
		return err
	}
	if state != "mapping" {
		return fmt.Errorf("mapping session is %s and permanently locked; do not start more work", state)
	}
	return nil
}

// Cancellation revokes the credential before a launcher starts terminating its
// process. A successfully submitted proposal survives every process outcome.
func EndMappingAttempt(database *sql.DB, workspaceID, id string, settled bool) (*MappingAttempt, error) {
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	if _, err = tx.Exec(`UPDATE mapping_attempts SET state=CASE WHEN state='mapping' THEN 'cancelled' ELSE state END,ended_at=CASE WHEN ? AND ended_at=0 THEN ? ELSE ended_at END WHERE workspace_id=? AND id=?`, settled, now, workspaceID, id); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`UPDATE architecture_proposal_drafts SET status='aborted',updated_at=? WHERE id=? AND workspace_id=? AND status='open'`, now, id, workspaceID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`UPDATE canvas_outbox SET status='cancelled' WHERE workspace_id=? AND id=(SELECT message_id FROM mapping_attempts WHERE id=?) AND status IN ('queued','delivered')`, workspaceID, id); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return GetMappingAttempt(database, workspaceID, id)
}

func sealMappingAttemptTx(tx *sql.Tx, workspaceID, id, proposalID string) error {
	var messageID, state string
	err := tx.QueryRow(`SELECT message_id,state FROM mapping_attempts WHERE workspace_id=? AND id=?`, workspaceID, id).Scan(&messageID, &state)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if state != "mapping" {
		return fmt.Errorf("mapping session is %s and permanently locked", state)
	}
	now := time.Now().UnixMilli()
	if _, err = tx.Exec(`UPDATE mapping_attempts SET state='submitted',proposal_id=?,submitted_at=? WHERE id=?`, proposalID, now, id); err != nil {
		return err
	}
	if messageID != "" {
		var status string
		if err = tx.QueryRow(`SELECT status FROM canvas_outbox WHERE workspace_id=? AND id=?`, workspaceID, messageID).Scan(&status); err != nil {
			return err
		}
		if status != "queued" && status != "delivered" {
			return fmt.Errorf("mapping request is already closed")
		}
		if _, err = tx.Exec(`INSERT INTO canvas_replies(message_id,body,agent,token,created_at,result_json) VALUES(?,'Architecture mapping submitted for review.','mapping',?,?,'')`, messageID, "mapping:"+id, now); err != nil {
			return err
		}
		if _, err = tx.Exec(`UPDATE canvas_outbox SET status='answered',answered_at=? WHERE workspace_id=? AND id=? AND status IN ('queued','delivered')`, now, workspaceID, messageID); err != nil {
			return err
		}
	}
	return nil
}

func mappingReviewReadyTx(tx *sql.Tx, workspaceID, proposalID string) error {
	var ended int64
	err := tx.QueryRow(`SELECT ended_at FROM mapping_attempts WHERE workspace_id=? AND proposal_id=?`, workspaceID, proposalID).Scan(&ended)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if ended == 0 {
		return fmt.Errorf("mapping session must stop before review")
	}
	return nil
}
