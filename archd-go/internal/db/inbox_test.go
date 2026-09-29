package db

import (
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func inboxFixture(t *testing.T) (*sql.DB, CanvasMessage) {
	t.Helper()
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err = UpsertWorkspace(d, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	m := CanvasMessage{WorkspaceID: "ws", Note: "Review this", Selection: "[]"}
	if err = EnqueueCanvasMessage(d, &m); err != nil {
		t.Fatal(err)
	}
	return d, m
}

func TestInboxHistoryKeepsSentSheetIdentityAfterSheetChanges(t *testing.T) {
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := UpsertWorkspace(d, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet-original", WorkspaceID: "ws", Name: "Checkout plan"}
	if err := CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	message := CanvasMessage{
		WorkspaceID: "ws", SheetID: &sheet.ID, Note: "Implement this sheet",
		SheetContext: `{"sheet":{"id":"sheet-original","name":"Checkout plan","revision":4}}`,
	}
	if err := EnqueueCanvasMessage(d, &message); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`UPDATE sheets SET name='Checkout plan revised',revision=5 WHERE id=?`, sheet.ID); err != nil {
		t.Fatal(err)
	}
	history, err := InboxHistory(d, "ws", "", 10, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].ID != message.ID || history[0].SentSheetName != "Checkout plan" || history[0].SentSheetRevision != 4 {
		t.Fatalf("sent sheet identity changed with the current sheet: %+v", history)
	}
	item, err := ReadInboxItem(d, message.ID, 1000)
	if err != nil || item.SentSheetName != "Checkout plan" || item.SentSheetRevision != 4 {
		t.Fatalf("single inbox read lost sent sheet identity: item=%+v err=%v", item, err)
	}
}

func TestInboxConcurrentClaimHasOneOwner(t *testing.T) {
	d, m := inboxFixture(t)
	var wg sync.WaitGroup
	results := make(chan []InboxItem, 20)
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			items, err := ClaimInbox(d, "ws", fmt.Sprint(i), "agent", 1000)
			results <- items
			errs <- err
		}(i)
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	count := 0
	for items := range results {
		count += len(items)
		if len(items) > 0 && items[0].ID != m.ID {
			t.Fatal("wrong message")
		}
	}
	if count != 1 {
		t.Fatalf("claims=%d want 1", count)
	}
}
func TestInboxExpiryRenewalFencingAndRetry(t *testing.T) {
	d, m := inboxFixture(t)
	first, err := ClaimInbox(d, "ws", "a", "agent-a", 1000)
	if err != nil {
		t.Fatal(err)
	}
	renewed, err := ClaimInbox(d, "ws", "a", "agent-a", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if first[0].LeaseToken != renewed[0].LeaseToken {
		t.Fatal("renewal changed token")
	}
	blocked, err := ClaimInbox(d, "ws", "b", "agent-b", 3000)
	if err != nil || len(blocked) != 0 {
		t.Fatalf("other agent got active lease: %v %v", blocked, err)
	}
	now := InboxLeaseMillis + 3000
	second, err := ClaimInbox(d, "ws", "b", "agent-b", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].LeaseToken == first[0].LeaseToken {
		t.Fatal("expired claim not reassigned")
	}
	if _, err = ReplyInbox(d, "ws", m.ID, first[0].LeaseToken, "old", now); !errors.Is(err, ErrInboxConflict) {
		t.Fatal("stale owner reply accepted", err)
	}
	reply, err := ReplyInbox(d, "ws", m.ID, second[0].LeaseToken, "answer", now)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := ReplyInbox(d, "ws", m.ID, second[0].LeaseToken, "answer", now+InboxLeaseMillis*2)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Reply.CreatedAt != duplicate.Reply.CreatedAt {
		t.Fatal("retry created new reply")
	}
	if _, err = ReplyInbox(d, "ws", m.ID, second[0].LeaseToken, "different", now); !errors.Is(err, ErrInboxConflict) {
		t.Fatal("changed retry accepted", err)
	}
	history, err := InboxHistory(d, "ws", "", 10, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].LeaseToken != "" || history[0].Reply.Body != "answer" {
		t.Fatalf("invalid history %+v", history)
	}
	other, err := InboxHistory(d, "other", "", 10, now)
	if err != nil || len(other) != 0 {
		t.Fatal("workspace leaked")
	}
}
func TestInboxReplySurvivesSheetDeletionAndRollsBackOnFailure(t *testing.T) {
	d, m := inboxFixture(t)
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Sheet"}
	if err := CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`UPDATE canvas_outbox SET sheet_id='sheet' WHERE id=?`, m.ID); err != nil {
		t.Fatal(err)
	}
	claim, err := ClaimInbox(d, "ws", "a", "a", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.Exec(`DELETE FROM sheets WHERE id='sheet'`); err != nil {
		t.Fatal(err)
	}
	if _, err = d.Exec(`CREATE TRIGGER fail_answer BEFORE UPDATE OF status ON canvas_outbox WHEN NEW.status='answered' BEGIN SELECT RAISE(ABORT,'injected failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = ReplyInbox(d, "ws", m.ID, claim[0].LeaseToken, "answer", 2000); err == nil {
		t.Fatal("expected failure")
	}
	var count int
	d.QueryRow(`SELECT count(*) FROM canvas_replies`).Scan(&count)
	if count != 0 {
		t.Fatal("reply insert escaped rollback")
	}
	d.Exec(`DROP TRIGGER fail_answer`)
	if _, err = ReplyInbox(d, "ws", m.ID, claim[0].LeaseToken, "answer", 2000); err != nil {
		t.Fatal(err)
	}
}
func TestInboxCancellationAndPagination(t *testing.T) {
	d, m := inboxFixture(t)
	claim, err := ClaimInbox(d, "ws", "a", "a", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err = CancelInbox(d, "ws", m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = ReplyInbox(d, "ws", m.ID, claim[0].LeaseToken, "late", 2000); !errors.Is(err, ErrInboxConflict) {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		message := CanvasMessage{ID: fmt.Sprint(i), WorkspaceID: "ws", Note: "test"}
		if err = EnqueueCanvasMessage(d, &message); err != nil {
			t.Fatal(err)
		}
	}
	d.Exec(`UPDATE canvas_outbox SET created_at=1234`)
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := InboxHistory(d, "ws", cursor, 2, 2000)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		for _, item := range page {
			if seen[item.ID] {
				t.Fatal("duplicate page")
			}
			seen[item.ID] = true
		}
		cursor = page[len(page)-1].ID
	}
	if len(seen) != 7 {
		t.Fatal("messages missing", seen)
	}
}
func TestInboxReopenPreservesRepliesAndRecoversLegacyDelivery(t *testing.T) {
	dir := t.TempDir()
	d, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := CanvasMessage{WorkspaceID: "ws", Note: "legacy"}
	if err = EnqueueCanvasMessage(d, &m); err != nil {
		t.Fatal(err)
	}
	d.Exec(`UPDATE canvas_outbox SET status='delivered' WHERE id=?`, m.ID)
	d.Close()
	d, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := ClaimInbox(d, "ws", "new", "new", 1000)
	if err != nil || len(claim) != 1 {
		t.Fatalf("legacy work lost %v", err)
	}
	if _, err = ReplyInbox(d, "ws", m.ID, claim[0].LeaseToken, "durable", 2000); err != nil {
		t.Fatal(err)
	}
	d.Close()
	d, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	item, err := ReadInboxItem(d, m.ID, 3000)
	if err != nil || item.Reply.Body != "durable" {
		t.Fatalf("reply lost %v", err)
	}
}
