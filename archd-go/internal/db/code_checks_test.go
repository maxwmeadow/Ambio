package db

import (
	"testing"
)

// A make-the-code-match order is verified by Ambio against the code, not taken
// on the agent's word.

func TestACodeCheckFollowsTheCode(t *testing.T) {
	sqlDB := fitFixture(t)
	findings := fitAfterMove(t, sqlDB, "billing", "payments")
	message := &CanvasMessage{WorkspaceID: "ws", Note: "make the code match"}
	must(t, EnqueueCanvasMessage(sqlDB, message))
	must(t, SaveWorkOrderCodeChecks(sqlDB, message.ID, findings))
	check := func() CodeCheckResult {
		t.Helper()
		results, err := WorkOrderCodeChecks(sqlDB, "ws", []string{message.ID})
		must(t, err)
		if len(results[message.ID]) != 1 {
			t.Fatalf("want one check, got %+v", results)
		}
		return results[message.ID][0]
	}

	if got := check(); got.State != CodeCheckDisagrees {
		t.Fatalf("before the work: %+v", got)
	}

	// The agent moves the file; the indexer keeps its identity.
	_, err := sqlDB.Exec(`UPDATE files SET rel_path = 'src/payments/billing.ts' WHERE id = 'billing'`)
	must(t, err)
	if got := check(); got.State != CodeCheckAgrees || got.Now != "src/payments/billing.ts now lives with the rest of Payments" {
		t.Fatalf("after the move: %+v", got)
	}

	// Someone changes the map instead: there is nothing left to verify.
	_, err = ApplyMeaningEdits(sqlDB, "ws", MeaningActor{Kind: "human"}, []MeaningEdit{
		{Op: MeaningAssign, FileIDs: []string{"billing"}, SystemID: "orders"},
	})
	must(t, err)
	if got := check(); got.State != CodeCheckMapChanged {
		t.Fatalf("after a map change: %+v", got)
	}

	_, err = sqlDB.Exec(`DELETE FROM files WHERE id = 'billing'`)
	must(t, err)
	if got := check(); got.State != CodeCheckFileGone {
		t.Fatalf("after deletion: %+v", got)
	}

	// Ordinary orders carry no checks.
	plain := &CanvasMessage{WorkspaceID: "ws", Note: "hello"}
	must(t, EnqueueCanvasMessage(sqlDB, plain))
	results, err := WorkOrderCodeChecks(sqlDB, "ws", []string{plain.ID})
	must(t, err)
	if len(results) != 0 {
		t.Fatalf("a plain order got checks: %+v", results)
	}
}
