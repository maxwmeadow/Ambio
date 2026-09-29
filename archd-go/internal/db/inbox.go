package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const InboxLeaseMillis int64 = 15 * 60 * 1000

var ErrInboxConflict = errors.New("message changed, claim expired, or another agent owns it; check the inbox again")

// Replies belong to messages, never to ephemeral canvas objects.
type InboxReply struct {
	Body      string      `json:"body"`
	Agent     string      `json:"agent"`
	CreatedAt int64       `json:"createdAt"`
	Result    *WorkResult `json:"result,omitempty"`
}
type WorkCheck struct {
	Command string `json:"command"`
	Outcome string `json:"outcome"`
}

// Result fields are reported by the agent. Axiom's independent checks are
// displayed separately, rather than silently promoting these claims to proof.
type WorkResult struct {
	Commit       string      `json:"commit,omitempty"`
	ChangedFiles []string    `json:"changedFiles,omitempty"`
	Checks       []WorkCheck `json:"checks,omitempty"`
	Remaining    []string    `json:"remaining,omitempty"`
}
type InboxReview struct {
	ID        string `json:"id"`
	Decision  string `json:"decision"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"createdAt"`
}
type WorkOrderChange struct {
	Kind         string `json:"kind"`
	SubjectLabel string `json:"subjectLabel"`
	ObjectLabel  string `json:"objectLabel,omitempty"`
	Count        int    `json:"count"`
	At           int64  `json:"at"`
}
type InboxItem struct {
	CanvasMessage
	LeaseToken     string            `json:"leaseToken,omitempty"`
	LeaseExpiresAt int64             `json:"leaseExpiresAt,omitempty"`
	Agent          string            `json:"agent,omitempty"`
	Reply          *InboxReply       `json:"reply,omitempty"`
	PriorReplies   []InboxReply      `json:"priorReplies,omitempty"`
	Review         *InboxReview      `json:"review,omitempty"`
	Reviews        []InboxReview     `json:"reviews,omitempty"`
	Sessions       []WorkSession     `json:"sessions,omitempty"`
	Changes        []WorkOrderChange `json:"changes,omitempty"`
}

func migrateInbox(d *sql.DB) error {
	_, err := d.Exec(`
 CREATE TABLE IF NOT EXISTS canvas_claims (
 message_id TEXT PRIMARY KEY REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 owner TEXT NOT NULL, agent TEXT NOT NULL, token TEXT NOT NULL,
 expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts>0)
 );
 CREATE INDEX IF NOT EXISTS canvas_history_order ON canvas_outbox(workspace_id,created_at,id);
 CREATE TABLE IF NOT EXISTS canvas_replies (
 message_id TEXT PRIMARY KEY REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 body TEXT NOT NULL CHECK(length(trim(body))>0), agent TEXT NOT NULL,
 token TEXT NOT NULL, created_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS canvas_reply_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 body TEXT NOT NULL, agent TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS canvas_reply_history_message ON canvas_reply_history(message_id,id);
 CREATE TABLE IF NOT EXISTS canvas_review_events (
 id TEXT PRIMARY KEY,
 message_id TEXT NOT NULL REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 decision TEXT NOT NULL CHECK(decision IN ('accepted','reopened')),
 note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS canvas_review_events_message ON canvas_review_events(message_id,created_at,id);
 INSERT OR IGNORE INTO canvas_replies(message_id,body,agent,token,created_at)
 SELECT m.id,a.body,a.author,'legacy',COALESCE(m.answered_at,a.created_at)
 FROM canvas_outbox m JOIN annotations a ON a.id=m.answer_annotation_id
 WHERE m.status='answered' AND length(trim(a.body))>0;
 UPDATE canvas_outbox SET status='queued',delivered_to=NULL,delivered_at=NULL
 WHERE status='delivered' AND NOT EXISTS(SELECT 1 FROM canvas_claims c WHERE c.message_id=canvas_outbox.id);
 CREATE TRIGGER IF NOT EXISTS canvas_status_insert BEFORE INSERT ON canvas_outbox
 WHEN NEW.status NOT IN ('queued','delivered','answered','cancelled') BEGIN SELECT RAISE(ABORT,'invalid canvas status'); END;
 CREATE TRIGGER IF NOT EXISTS canvas_status_update BEFORE UPDATE OF status ON canvas_outbox
 WHEN NEW.status NOT IN ('queued','delivered','answered','cancelled') BEGIN SELECT RAISE(ABORT,'invalid canvas status'); END;
	`)
	if err != nil {
		return err
	}
	_, err = d.Exec(`ALTER TABLE canvas_replies ADD COLUMN result_json TEXT NOT NULL DEFAULT ''`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return err
	}
	return nil
}

const inboxColumns = `m.id,m.workspace_id,m.delivery_mode,m.sheet_id,m.note,m.selection,m.change_summary,
 m.status,m.delivered_to,m.answer_annotation_id,m.created_at,m.delivered_at,m.answered_at,
 COALESCE(c.token,''),COALESCE(c.expires_at,0),COALESCE(c.agent,''),
 r.body,COALESCE(r.agent,''),COALESCE(r.created_at,0),COALESCE(r.result_json,''),
 v.id,COALESCE(v.decision,''),COALESCE(v.note,''),COALESCE(v.created_at,0)`
const inboxJoins = ` FROM canvas_outbox m LEFT JOIN canvas_claims c ON c.message_id=m.id LEFT JOIN canvas_replies r ON r.message_id=m.id
 LEFT JOIN canvas_review_events v ON v.id=(SELECT id FROM canvas_review_events WHERE message_id=m.id ORDER BY rowid DESC LIMIT 1) `

type inboxScanner interface{ Scan(...any) error }

func scanInbox(row inboxScanner, now int64) (*InboxItem, error) {
	item := &InboxItem{}
	var body sql.NullString
	var resultJSON string
	var reviewID sql.NullString
	var review InboxReview
	reply := &InboxReply{}
	err := row.Scan(&item.ID, &item.WorkspaceID, &item.DeliveryMode, &item.SheetID, &item.Note, &item.Selection, &item.ChangeSummary,
		&item.Status, &item.DeliveredTo, &item.AnswerAnnotationID, &item.CreatedAt, &item.DeliveredAt, &item.AnsweredAt,
		&item.LeaseToken, &item.LeaseExpiresAt, &item.Agent, &body, &reply.Agent, &reply.CreatedAt, &resultJSON,
		&reviewID, &review.Decision, &review.Note, &review.CreatedAt)
	if err != nil {
		return nil, err
	}
	if body.Valid {
		reply.Body = body.String
		if resultJSON != "" {
			if err := json.Unmarshal([]byte(resultJSON), &reply.Result); err != nil {
				return nil, err
			}
		}
		item.Reply = reply
	}
	if reviewID.Valid {
		review.ID = reviewID.String
		item.Review = &review
	}
	if item.Status == "delivered" && item.LeaseExpiresAt <= now {
		item.Status = "queued"
		item.DeliveredTo = nil
	}
	return item, nil
}

// History reads replies and ownership in the same SQLite snapshot. It never
// loads large context payloads or exposes claim credentials.
func InboxHistory(d *sql.DB, workspace, before string, limit int, now int64) ([]InboxItem, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	rows, err := d.Query("SELECT "+inboxColumns+inboxJoins+` WHERE m.workspace_id=?
 AND (?='' OR (m.created_at,m.id)<(SELECT created_at,id FROM canvas_outbox WHERE id=? AND workspace_id=?))
 ORDER BY m.created_at DESC,m.id DESC LIMIT ?`, workspace, before, before, workspace, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []InboxItem{}
	messageIDs := []string{}
	for rows.Next() {
		item, err := scanInbox(rows, now)
		if err != nil {
			return nil, err
		}
		item.LeaseToken = ""
		items = append(items, *item)
		messageIDs = append(messageIDs, item.ID)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	sessions, err := InboxWorkSessions(d, workspace, messageIDs)
	if err != nil {
		return nil, err
	}
	for i := range items {
		items[i].Sessions = sessions[items[i].ID]
		if err := loadPriorReplies(d, &items[i]); err != nil {
			return nil, err
		}
		if err := loadReviews(d, &items[i]); err != nil {
			return nil, err
		}
		if err := loadWorkOrderChanges(d, &items[i]); err != nil {
			return nil, err
		}
	}
	return items, nil
}
func ReadInboxItem(d *sql.DB, id string, now int64) (*InboxItem, error) {
	item, err := scanInbox(d.QueryRow("SELECT "+inboxColumns+inboxJoins+" WHERE m.id=?", id), now)
	if err != nil {
		return nil, err
	}
	if err := loadPriorReplies(d, item); err != nil {
		return nil, err
	}
	if err := loadReviews(d, item); err != nil {
		return nil, err
	}
	return item, loadWorkOrderChanges(d, item)
}

func loadReviews(d *sql.DB, item *InboxItem) error {
	rows, err := d.Query(`SELECT id,decision,note,created_at FROM canvas_review_events WHERE message_id=? ORDER BY rowid`, item.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var review InboxReview
		if err := rows.Scan(&review.ID, &review.Decision, &review.Note, &review.CreatedAt); err != nil {
			return err
		}
		item.Reviews = append(item.Reviews, review)
	}
	return rows.Err()
}

func loadWorkOrderChanges(d *sql.DB, item *InboxItem) error {
	rows, err := d.Query(`SELECT se.kind,se.subject_label,se.object_label,se.count,se.ts
 FROM structural_events se JOIN work_sessions ws ON ws.id=se.session_id AND ws.workspace_id=se.workspace_id
 WHERE se.workspace_id=? AND ws.message_id=? ORDER BY se.ts DESC,se.id DESC LIMIT 50`, item.WorkspaceID, item.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var change WorkOrderChange
		if err := rows.Scan(&change.Kind, &change.SubjectLabel, &change.ObjectLabel, &change.Count, &change.At); err != nil {
			return err
		}
		item.Changes = append(item.Changes, change)
	}
	return rows.Err()
}

func loadPriorReplies(d *sql.DB, item *InboxItem) error {
	rows, err := d.Query(`SELECT body,agent,result_json,created_at FROM canvas_reply_history WHERE message_id=? ORDER BY id`, item.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var reply InboxReply
		var resultJSON string
		if err := rows.Scan(&reply.Body, &reply.Agent, &resultJSON, &reply.CreatedAt); err != nil {
			return err
		}
		if resultJSON != "" {
			if err := json.Unmarshal([]byte(resultJSON), &reply.Result); err != nil {
				return err
			}
		}
		item.PriorReplies = append(item.PriorReplies, reply)
	}
	return rows.Err()
}

// SQLite's BEGIN IMMEDIATE serializes selection and ownership assignment.
// At most one instruction is claimed per call: don't reserve a whole backlog.
func ClaimInbox(d *sql.DB, workspace, owner, agent string, now int64) ([]InboxItem, error) {
	return claimInbox(d, workspace, owner, agent, "", now)
}

// ClaimInboxByID lets the human hand one durable request to a chosen chat.
// The ID selects work; the existing lease still fences concurrent agents.
func ClaimInboxByID(d *sql.DB, workspace, owner, agent, messageID string, now int64) ([]InboxItem, error) {
	if messageID == "" {
		return nil, ErrInboxConflict
	}
	return claimInbox(d, workspace, owner, agent, messageID, now)
}

func claimInbox(d *sql.DB, workspace, owner, agent, messageID string, now int64) ([]InboxItem, error) {
	if owner == "" || agent == "" {
		return nil, fmt.Errorf("owner and agent required")
	}
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var id string
	if messageID == "" {
		err = tx.QueryRow(`SELECT m.id FROM canvas_outbox m LEFT JOIN canvas_claims c ON c.message_id=m.id
 WHERE m.workspace_id=? AND m.delivery_mode='open' AND m.status IN ('queued','delivered')
 AND (c.message_id IS NULL OR c.expires_at<=? OR c.owner=?)
 ORDER BY CASE WHEN c.owner=? AND c.expires_at>? THEN 0 ELSE 1 END,m.created_at,m.id LIMIT 1`, workspace, now, owner, owner, now).Scan(&id)
	} else {
		err = tx.QueryRow(`SELECT m.id FROM canvas_outbox m LEFT JOIN canvas_claims c ON c.message_id=m.id
 WHERE m.workspace_id=? AND m.id=? AND m.status IN ('queued','delivered')
 AND (c.message_id IS NULL OR c.expires_at<=? OR c.owner=?)`, workspace, messageID, now, owner).Scan(&id)
	}
	if err == sql.ErrNoRows {
		if messageID != "" {
			return nil, ErrInboxConflict
		}
		return []InboxItem{}, nil
	}
	if err != nil {
		return nil, err
	}
	token := uuid.NewString()
	var priorOwner, priorToken string
	var expiry int64
	err = tx.QueryRow(`SELECT owner,token,expires_at FROM canvas_claims WHERE message_id=?`, id).Scan(&priorOwner, &priorToken, &expiry)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if priorOwner == owner && expiry > now {
		token = priorToken
	}
	_, err = tx.Exec(`INSERT INTO canvas_claims(message_id,owner,agent,token,expires_at) VALUES(?,?,?,?,?)
 ON CONFLICT(message_id) DO UPDATE SET owner=excluded.owner,agent=excluded.agent,token=excluded.token,
 expires_at=excluded.expires_at,attempts=canvas_claims.attempts+CASE WHEN canvas_claims.token=excluded.token THEN 0 ELSE 1 END`, id, owner, agent, token, now+InboxLeaseMillis)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`UPDATE canvas_outbox SET status='delivered',delivered_to=?,delivered_at=? WHERE id=?`, owner, now, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	item, err := ReadInboxItem(d, id, now)
	if err != nil {
		return nil, err
	}
	return []InboxItem{*item}, nil
}

func ReplyInbox(d *sql.DB, workspace, id, token, body string, now int64, reported ...*WorkResult) (*InboxItem, error) {
	var result *WorkResult
	if len(reported) > 0 {
		result = reported[0]
	}
	resultJSON := ""
	if result != nil {
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		resultJSON = string(encoded)
	}
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status string
	if err = tx.QueryRow(`SELECT status FROM canvas_outbox WHERE id=? AND workspace_id=?`, id, workspace).Scan(&status); err != nil {
		return nil, err
	}
	var priorBody, priorToken, priorResult string
	err = tx.QueryRow(`SELECT body,token,result_json FROM canvas_replies WHERE message_id=?`, id).Scan(&priorBody, &priorToken, &priorResult)
	if err == nil {
		if priorToken != token || priorBody != body || priorResult != resultJSON {
			return nil, ErrInboxConflict
		}
		tx.Rollback()
		return ReadInboxItem(d, id, now)
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	var agent string
	err = tx.QueryRow(`SELECT agent FROM canvas_claims WHERE message_id=? AND token=? AND expires_at>?`, id, token, now).Scan(&agent)
	if err == sql.ErrNoRows || status != "delivered" {
		return nil, ErrInboxConflict
	}
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`INSERT INTO canvas_replies(message_id,body,agent,token,created_at,result_json) VALUES(?,?,?,?,?,?)`, id, body, agent, token, now, resultJSON)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`UPDATE canvas_outbox SET status='answered',answered_at=? WHERE id=?`, now, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return ReadInboxItem(d, id, now)
}

// ReviewInbox records the user's decision. Reopening preserves the previous
// submission and feedback, then releases the order for another explicit claim.
// The review ID makes an uncertain HTTP retry safe.
func ReviewInbox(d *sql.DB, workspace, id, reviewID, decision, note string, now int64) (*InboxItem, error) {
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var previousMessage, previousDecision, previousNote string
	err = tx.QueryRow(`SELECT message_id,decision,note FROM canvas_review_events WHERE id=?`, reviewID).Scan(&previousMessage, &previousDecision, &previousNote)
	if err == nil {
		if previousMessage != id || previousDecision != decision || previousNote != note {
			return nil, ErrInboxConflict
		}
		tx.Rollback()
		item, err := ReadInboxItem(d, id, now)
		if err != nil || item.WorkspaceID != workspace {
			return nil, ErrInboxConflict
		}
		return item, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	var status string
	if err = tx.QueryRow(`SELECT status FROM canvas_outbox WHERE id=? AND workspace_id=?`, id, workspace).Scan(&status); err != nil {
		return nil, err
	}
	if status != "answered" {
		return nil, ErrInboxConflict
	}
	var body, agent, resultJSON string
	var repliedAt int64
	if err = tx.QueryRow(`SELECT body,agent,result_json,created_at FROM canvas_replies WHERE message_id=?`, id).Scan(&body, &agent, &resultJSON, &repliedAt); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`INSERT INTO canvas_review_events(id,message_id,decision,note,created_at) VALUES(?,?,?,?,?)`, reviewID, id, decision, note, now); err != nil {
		return nil, err
	}
	if decision == "reopened" {
		if _, err = tx.Exec(`INSERT INTO canvas_reply_history(message_id,body,agent,result_json,created_at) VALUES(?,?,?,?,?)`, id, body, agent, resultJSON, repliedAt); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(`DELETE FROM canvas_replies WHERE message_id=?`, id); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(`DELETE FROM canvas_claims WHERE message_id=?`, id); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(`UPDATE canvas_outbox SET status='queued',delivered_to=NULL,delivered_at=NULL,answered_at=NULL WHERE id=?`, id); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(`UPDATE work_sessions SET ended_at=? WHERE workspace_id=? AND message_id=? AND ended_at=0`, now, workspace, id); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return ReadInboxItem(d, id, now)
}

func CancelInbox(d *sql.DB, workspace, id string) error {
	result, err := d.Exec(`UPDATE canvas_outbox SET status='cancelled' WHERE id=? AND workspace_id=? AND status IN ('queued','delivered','cancelled')`, id, workspace)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrInboxConflict
	}
	return nil
}
