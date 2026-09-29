package db

import (
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"
)

func workSessionTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	return sqlDB
}

func TestWorkSessionsRemainOpenAcrossIndependentOwners(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	first, err := StartWorkSession(sqlDB, WorkSession{
		ID: "a-1", WorkspaceID: "ws", OwnerKey: "owner-a",
		Goal: "Change auth", FocusSystemIDs: []string{"auth"},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := StartWorkSession(sqlDB, WorkSession{
		ID: "b-1", WorkspaceID: "ws", OwnerKey: "owner-b",
		Goal: "Change billing", FocusSystemIDs: []string{"billing"},
	})
	if err != nil {
		t.Fatal(err)
	}

	active, err := GetActiveWorkSessions(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 {
		t.Fatalf("parallel owners should both remain visible: %#v", active)
	}

	if _, err := StartWorkSession(sqlDB, WorkSession{
		ID: "a-2", WorkspaceID: "ws", OwnerKey: "owner-a",
		Goal: "Continue auth", FocusFileIDs: []string{"token-file"},
	}); err != nil {
		t.Fatal(err)
	}
	first, err = GetWorkSession(sqlDB, "ws", first.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err = GetWorkSession(sqlDB, "ws", second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.EndedAt == 0 {
		t.Fatal("an owner's forgotten session should be closed by its next task")
	}
	if second.EndedAt != 0 {
		t.Fatal("one owner starting work must not close another agent's session")
	}
}

func TestInboxWorkSessionsStaySeparateForChatsSharingOneConnector(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	now := time.Now().UnixMilli()
	for _, id := range []string{"request-a", "request-b"} {
		message := CanvasMessage{ID: id, WorkspaceID: "ws", DeliveryMode: "addressed", Note: id, Selection: "[]"}
		if err := EnqueueCanvasMessage(sqlDB, &message); err != nil {
			t.Fatal(err)
		}
	}
	firstClaim, err := ClaimInboxByID(sqlDB, "ws", "connector", "codex", "request-a", now)
	if err != nil {
		t.Fatal(err)
	}
	secondClaim, err := ClaimInboxByID(sqlDB, "ws", "connector", "codex", "request-b", now)
	if err != nil {
		t.Fatal(err)
	}
	first := WorkSession{ID: "work-a", WorkspaceID: "ws", MessageID: "request-a", OwnerKey: "process", Goal: "A"}
	second := WorkSession{ID: "work-b", WorkspaceID: "ws", MessageID: "request-b", OwnerKey: "process", Goal: "B"}
	if _, err = StartInboxWorkSession(sqlDB, first, "connector", secondClaim[0].LeaseToken); !errors.Is(err, ErrInboxConflict) {
		t.Fatalf("wrong request token accepted: %v", err)
	}
	if _, err = StartInboxWorkSession(sqlDB, first, "other-connector", firstClaim[0].LeaseToken); !errors.Is(err, ErrInboxConflict) {
		t.Fatalf("wrong connector accepted: %v", err)
	}
	startedA, err := StartInboxWorkSession(sqlDB, first, "connector", firstClaim[0].LeaseToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = StartInboxWorkSession(sqlDB, second, "connector", secondClaim[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	resumed, err := StartInboxWorkSession(sqlDB, WorkSession{ID: "retry", WorkspaceID: "ws", MessageID: "request-a", OwnerKey: "process", Goal: "A"}, "connector", firstClaim[0].LeaseToken)
	if err != nil || resumed.ID != startedA.ID {
		t.Fatalf("retry did not resume the same session: %#v %v", resumed, err)
	}
	active, err := GetActiveWorkSessions(sqlDB, "ws")
	if err != nil || len(active) != 2 {
		t.Fatalf("shared connector lost a chat: %#v %v", active, err)
	}
	if err := AppendWorkSessionNoteByID(sqlDB, "ws", "work-b", "progress B", "wrong-process"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("foreign owner wrote a note: %v", err)
	}
	if err := AppendWorkSessionNoteByID(sqlDB, "ws", "work-b", "progress B", "process"); err != nil {
		t.Fatal(err)
	}
	if err := FinishWorkSessionByID(sqlDB, "ws", "work-a", "done A", "process"); err != nil {
		t.Fatal(err)
	}
	takeover, err := ClaimInboxByID(sqlDB, "ws", "new-connector", "claude", "request-b", now+InboxLeaseMillis+1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := StartInboxWorkSession(sqlDB, WorkSession{ID: "work-b-takeover", WorkspaceID: "ws", MessageID: "request-b", OwnerKey: "new-process", Goal: "Continue B"}, "new-connector", takeover[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	if err := AppendWorkSessionNoteByID(sqlDB, "ws", "work-b", "stale progress", "process"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("stale connector wrote progress after takeover: %v", err)
	}
	history, err := InboxHistory(sqlDB, "ws", "", 10, now)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]InboxItem{}
	for _, item := range history {
		byID[item.ID] = item
	}
	if len(byID["request-a"].Sessions) != 1 || byID["request-a"].Sessions[0].Summary != "done A" || len(byID["request-b"].Sessions) != 2 || byID["request-b"].Sessions[0].Notes[0].Text != "progress B" || byID["request-b"].Sessions[0].EndedAt == 0 || byID["request-b"].Sessions[1].ID != "work-b-takeover" {
		t.Fatalf("progress was not attached to the right requests: %#v", byID)
	}
}

func TestConcurrentWorkNotesAreNotLost(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	if _, err := StartWorkSession(sqlDB, WorkSession{ID: "work", WorkspaceID: "ws", OwnerKey: "process", Goal: "Track progress"}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errors := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errors <- AppendWorkSessionNoteByID(sqlDB, "ws", "work", "progress", "process")
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	session, err := GetWorkSession(sqlDB, "ws", "work")
	if err != nil || len(session.Notes) != 12 {
		t.Fatalf("concurrent notes were lost: %d notes, %v", len(session.Notes), err)
	}
}

func TestFocusedAttributionRefusesAmbiguousParallelWork(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	for _, session := range []WorkSession{
		{
			ID: "auth-work", WorkspaceID: "ws", OwnerKey: "owner-a",
			Goal: "Auth", FocusSystemIDs: []string{"auth"}, FocusFileIDs: []string{"token-file"},
		},
		{
			ID: "billing-work", WorkspaceID: "ws", OwnerKey: "owner-b",
			Goal: "Billing", FocusSystemIDs: []string{"billing"},
		},
	} {
		if _, err := StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}

	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "token-file"); got != "auth-work" {
		t.Fatalf("file scope should select auth work, got %q", got)
	}
	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "billing"); got != "billing-work" {
		t.Fatalf("system scope should select billing work, got %q", got)
	}
	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "unrelated"); got != "" {
		t.Fatalf("unmatched parallel work must remain unexplained, got %q", got)
	}
	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "auth", "billing"); got != "" {
		t.Fatalf("an event touching two declared scopes is ambiguous, got %q", got)
	}
}

func TestSessionSpecificNotesAndFinishDoNotMutateAnotherAgent(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	for _, session := range []WorkSession{
		{ID: "a", WorkspaceID: "ws", OwnerKey: "owner-a", Goal: "A"},
		{ID: "b", WorkspaceID: "ws", OwnerKey: "owner-b", Goal: "B"},
	} {
		if _, err := StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}
	if err := AppendWorkSessionNoteByID(sqlDB, "ws", "a", "decision A"); err != nil {
		t.Fatal(err)
	}
	if err := FinishWorkSessionByID(sqlDB, "ws", "a", "done A"); err != nil {
		t.Fatal(err)
	}
	a, _ := GetWorkSession(sqlDB, "ws", "a")
	b, _ := GetWorkSession(sqlDB, "ws", "b")
	if len(a.Notes) != 1 || a.Summary != "done A" || a.EndedAt == 0 {
		t.Fatalf("target session was not updated: %#v", a)
	}
	if len(b.Notes) != 0 || b.Summary != "" || b.EndedAt != 0 {
		t.Fatalf("another agent's session was mutated: %#v", b)
	}
}

func TestUpdateCollapseNeverMergesDifferentWorkSessions(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	for _, sessionID := range []string{"work-a", "work-b"} {
		if err := RecordStructuralEvent(sqlDB, StructuralEvent{
			WorkspaceID: "ws",
			TS:          100,
			Actor:       "agent",
			Kind:        EventFileUpdated,
			SubjectID:   "shared-file",
			SessionID:   sessionID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	events, err := GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("parallel agents' saves must not collapse into one attribution: %#v", events)
	}
}
