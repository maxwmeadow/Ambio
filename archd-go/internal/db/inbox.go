package db

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

const InboxLeaseMillis int64 = 15 * 60 * 1000

var ErrInboxConflict = errors.New("message changed, claim expired, or another agent owns it; check the inbox again")

// Replies belong to messages, never to ephemeral canvas objects.
type InboxReply struct {
	Body      string `json:"body"`
	Agent     string `json:"agent"`
	CreatedAt int64  `json:"createdAt"`
}
type InboxItem struct {
	CanvasMessage
	LeaseToken     string        `json:"leaseToken,omitempty"`
	LeaseExpiresAt int64         `json:"leaseExpiresAt,omitempty"`
	Agent          string        `json:"agent,omitempty"`
	Reply          *InboxReply   `json:"reply,omitempty"`
	Sessions       []WorkSession `json:"sessions,omitempty"`
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
	return err
}

const inboxColumns = `m.id,m.workspace_id,m.delivery_mode,m.sheet_id,m.note,m.selection,m.change_summary,
 m.status,m.delivered_to,m.answer_annotation_id,m.created_at,m.delivered_at,m.answered_at,
 COALESCE(c.token,''),COALESCE(c.expires_at,0),COALESCE(c.agent,''),
 r.body,COALESCE(r.agent,''),COALESCE(r.created_at,0)`
const inboxJoins = ` FROM canvas_outbox m LEFT JOIN canvas_claims c ON c.message_id=m.id LEFT JOIN canvas_replies r ON r.message_id=m.id `

type inboxScanner interface{ Scan(...any) error }

func scanInbox(row inboxScanner, now int64) (*InboxItem, error) {
	item := &InboxItem{}
	var body sql.NullString
	reply := &InboxReply{}
	err := row.Scan(&item.ID, &item.WorkspaceID, &item.DeliveryMode, &item.SheetID, &item.Note, &item.Selection, &item.ChangeSummary,
		&item.Status, &item.DeliveredTo, &item.AnswerAnnotationID, &item.CreatedAt, &item.DeliveredAt, &item.AnsweredAt,
		&item.LeaseToken, &item.LeaseExpiresAt, &item.Agent, &body, &reply.Agent, &reply.CreatedAt)
	if err != nil {
		return nil, err
	}
	if body.Valid {
		reply.Body = body.String
		item.Reply = reply
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
	}
	return items, nil
}
func ReadInboxItem(d *sql.DB, id string, now int64) (*InboxItem, error) {
	return scanInbox(d.QueryRow("SELECT "+inboxColumns+inboxJoins+" WHERE m.id=?", id), now)
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

func ReplyInbox(d *sql.DB, workspace, id, token, body string, now int64) (*InboxItem, error) {
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status string
	if err = tx.QueryRow(`SELECT status FROM canvas_outbox WHERE id=? AND workspace_id=?`, id, workspace).Scan(&status); err != nil {
		return nil, err
	}
	var priorBody, priorToken string
	err = tx.QueryRow(`SELECT body,token FROM canvas_replies WHERE message_id=?`, id).Scan(&priorBody, &priorToken)
	if err == nil {
		if priorToken != token || priorBody != body {
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
	_, err = tx.Exec(`INSERT INTO canvas_replies(message_id,body,agent,token,created_at) VALUES(?,?,?,?,?)`, id, body, agent, token, now)
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
