package db

import (
	"reflect"
	"testing"
)

func TestFileAuthorsSinceNamesWhoChangedAFileSinceItsCommit(t *testing.T) {
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`INSERT INTO work_sessions (id, workspace_id, agent, goal, started_at) VALUES ('s1', 'ws', 'codex', 'Fix threshold', 100)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		ts      int64
		actor   string
		kind    string
		subject string
		session string
		count   int
	}{
		{50, "agent", EventFileUpdated, "heur", "s1", 1},       // before the commit
		{200, "agent", EventFileUpdated, "heur", "s1", 3},      // Codex, three saves
		{300, "human", EventFileUpdated, "heur", "", 1},        // a person, later
		{400, "agent", EventFileUpdated, "other", "s1", 1},     // another file
		{500, "agent", EventEdgeAdded, "heur", "s1", 1},        // not a change to the text
		{250, "agent", EventFileUpdated, "heur", "missing", 1}, // a session since pruned
	} {
		if _, err := d.Exec(`INSERT INTO structural_events (workspace_id, ts, actor, kind, subject_id, session_id, count) VALUES ('ws', ?, ?, ?, ?, ?, ?)`,
			row.ts, row.actor, row.kind, row.subject, row.session, row.count); err != nil {
			t.Fatal(err)
		}
	}
	authors, err := FileAuthorsSince(d, "ws", "heur", 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []FileAuthor{
		{Actor: "human", LastAt: 300, Saves: 1},
		{Actor: "agent", SessionID: "missing", LastAt: 250, Saves: 1},
		{Actor: "agent", SessionID: "s1", Agent: "codex", Goal: "Fix threshold", LastAt: 200, Saves: 3},
	}
	if !reflect.DeepEqual(authors, want) {
		t.Fatalf("authors = %+v", authors)
	}
	if none, _ := FileAuthorsSince(d, "ws", "heur", 1000); len(none) != 0 {
		t.Fatalf("after the last change: %+v", none)
	}
}
