package db

import (
	"database/sql"
	"fmt"
	"sync"
	"testing"
)

func mappingFixture(t *testing.T) *sql.DB {
	t.Helper()
	d, err := Open(t.TempDir())
	must(t, err)
	t.Cleanup(func() { d.Close() })
	must(t, UpsertWorkspace(d, Workspace{ID: "ws", Name: "mapping"}))
	must(t, UpsertRoot(d, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}))
	for _, id := range []string{"a.go", "b.go"} {
		must(t, UpsertFile(d, File{ID: id, RootID: "root", Path: id, RelPath: id, Language: "go"}))
	}
	must(t, EnqueueCanvasMessage(d, &CanvasMessage{ID: "request", WorkspaceID: "ws", Mode: "propose", DeliveryMode: "addressed", Note: "Map the project"}))
	_, err = StartMappingAttempt(d, "ws", "root", "map", "request", "hash")
	must(t, err)
	_, err = AddArchitectureProposalDraftChunk(d, "map", "ws", "first", []DraftSystem{{SystemKey: "a", Name: "A", Files: []string{"a.go"}}})
	must(t, err)
	return d
}

func TestMappingCommitIsFinalAndReviewWaitsForProcess(t *testing.T) {
	d := mappingFixture(t)
	must(t, NoteMappingAttempt(d, "ws", "map", "Boundary rationale from the source", "Two responsibilities"))
	p, err := CommitArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	m, err := GetMappingAttempt(d, "ws", "map")
	must(t, err)
	if m.State != "submitted" || m.ProposalID != p.ID || m.EndedAt != 0 || m.SystemCount != 1 {
		t.Fatalf("bad submission receipt: %#v", m)
	}
	if p.Round.EvidenceSummary != "Boundary rationale from the source" {
		t.Fatalf("notes lost: %#v", p.Round)
	}
	var status string
	must(t, d.QueryRow(`SELECT status FROM canvas_outbox WHERE id='request'`).Scan(&status))
	if status != "answered" {
		t.Fatal("commit did not close the request")
	}
	if err = NoteMappingAttempt(d, "ws", "map", "too late", ""); err == nil {
		t.Fatal("late note accepted")
	}
	if _, err = FinalizeArchitectureProposal(d, p.ID, "ws", 1, "user"); err == nil {
		t.Fatal("review finished while process still active")
	}
	if _, err = StartMappingAttempt(d, "ws", "root", "second", "", "hash"); err == nil {
		t.Fatal("replacement started before old process stopped")
	}
	replay, err := CommitArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	if replay.ID != p.ID {
		t.Fatal("submission replay duplicated proposal")
	}
	m, err = EndMappingAttempt(d, "ws", "map", true)
	must(t, err)
	if m.State != "submitted" || m.EndedAt == 0 {
		t.Fatal("process settlement lost valid proposal")
	}
	_, err = FinalizeArchitectureProposal(d, p.ID, "ws", 1, "user")
	must(t, err)
	if _, err = AddArchitectureProposalRevision(d, p.ID, "ws", 1, ArchitectureProposalRound{Coverage: "no_change"}); err == nil {
		t.Fatal("sealed mapping proposal reopened")
	}
	_, err = StartMappingAttempt(d, "ws", "root", "second", "", "hash")
	must(t, err)
}

func TestMappingSubmissionRollsBackWhenAutomaticCompletionFails(t *testing.T) {
	d := mappingFixture(t)
	_, err := d.Exec(`CREATE TRIGGER reject_mapping_reply BEFORE INSERT ON canvas_replies BEGIN SELECT RAISE(ABORT,'injected reply failure'); END;`)
	must(t, err)
	if _, err = CommitArchitectureProposalDraft(d, "map", "ws"); err == nil {
		t.Fatal("expected reply failure")
	}
	var n int
	must(t, d.QueryRow(`SELECT COUNT(*) FROM architecture_proposals`).Scan(&n))
	if n != 0 {
		t.Fatal("failed completion leaked proposal")
	}
	m, err := GetMappingAttempt(d, "ws", "map")
	must(t, err)
	if m.State != "mapping" {
		t.Fatal("failed commit closed attempt")
	}
	_, err = d.Exec(`DROP TRIGGER reject_mapping_reply`)
	must(t, err)
	_, err = CommitArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
}

func TestMappingSubmitSerializesWithCancellationAndChunkArrival(t *testing.T) {
	for i := 0; i < 12; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			d := mappingFixture(t)
			start := make(chan struct{})
			var wg sync.WaitGroup
			var submitted *ArchitectureProposal
			var submitErr, chunkErr error
			wg.Add(3)
			go func() {
				defer wg.Done()
				<-start
				submitted, submitErr = CommitArchitectureProposalDraft(d, "map", "ws")
			}()
			go func() {
				defer wg.Done()
				<-start
				_, chunkErr = AddArchitectureProposalDraftChunk(d, "map", "ws", "late", []DraftSystem{{SystemKey: "b", Name: "B", Files: []string{"b.go"}}})
			}()
			go func() {
				defer wg.Done()
				<-start
				_, err := EndMappingAttempt(d, "ws", "map", false)
				if err != nil {
					t.Error(err)
				}
			}()
			close(start)
			wg.Wait()
			m, err := GetMappingAttempt(d, "ws", "map")
			must(t, err)
			proposals, err := ListArchitectureProposals(d, "ws")
			must(t, err)
			if submitErr == nil {
				if m.State != "submitted" || len(proposals) != 1 || submitted.ID != m.ProposalID {
					t.Fatalf("commit/cancel split: %#v", m)
				}
				if chunkErr == nil && len(submitted.Round.Systems) != 2 {
					t.Fatal("accepted concurrent chunk was lost")
				}
			} else if m.State != "cancelled" || len(proposals) != 0 {
				t.Fatalf("cancel leaked submission: state=%s proposals=%d err=%v", m.State, len(proposals), submitErr)
			}
		})
	}
}

func TestMappingDraftCannotBypassCancellationThroughGenericAbort(t *testing.T) {
	d := mappingFixture(t)
	if err := AbortArchitectureProposalDraft(d, "map", "ws"); err == nil {
		t.Fatal("generic abort bypassed mapping lifecycle")
	}
	m, err := GetMappingAttempt(d, "ws", "map")
	must(t, err)
	if m.State != "mapping" {
		t.Fatal("failed generic abort changed attempt")
	}
}

func TestResetMappingDraftStartsTheMapOverUntilSubmission(t *testing.T) {
	d := mappingFixture(t)
	must(t, NoteMappingAttempt(d, "ws", "map", "Kept across the reset", ""))
	must(t, ResetMappingDraft(d, "ws", "map"))
	draft, err := GetArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	if draft.Status != "open" || len(draft.Systems) != 0 || draft.ChunkCount != 0 {
		t.Fatalf("reset kept drafted systems: %#v", draft)
	}
	// The chunkId and systemKey the agent used before are free again.
	_, err = AddArchitectureProposalDraftChunk(d, "map", "ws", "first", []DraftSystem{{SystemKey: "a", Name: "A", Files: []string{"a.go", "b.go"}}})
	must(t, err)
	p, err := CommitArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	if len(p.Round.Memberships) != 2 || p.Round.EvidenceSummary != "Kept across the reset" {
		t.Fatalf("redrawn map lost files or notes: %#v", p.Round)
	}
	if err = ResetMappingDraft(d, "ws", "map"); err == nil {
		t.Fatal("submitted mapping was reset")
	}
}

func TestMappingCommitRecoversPreV10ProposalBeforeDraftCrash(t *testing.T) {
	d := mappingFixture(t)
	_, err := d.Exec(`DELETE FROM mapping_attempts WHERE id='map'`)
	must(t, err)
	original, err := CommitArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	_, err = d.Exec(`UPDATE architecture_proposal_drafts SET status='open',proposal_id='' WHERE id='map'`)
	must(t, err)
	replay, err := CommitArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	if replay.ID != original.ID {
		t.Fatal("crash recovery duplicated proposal")
	}
	draft, err := GetArchitectureProposalDraft(d, "map", "ws")
	must(t, err)
	if draft.Status != "committed" {
		t.Fatal("old crash window not repaired")
	}
}
