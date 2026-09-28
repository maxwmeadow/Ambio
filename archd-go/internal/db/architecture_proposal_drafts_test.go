package db

import (
	"strings"
	"testing"
)

func TestArchitectureProposalDraftSurvivesRestartAndCommitsOnce(t *testing.T) {
	dir := t.TempDir()
	database, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "draft test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"a.go", "b.go"} {
		if err := UpsertFile(database, File{ID: file, RootID: "root", Path: file, RelPath: file, Language: "go"}); err != nil {
			t.Fatal(err)
		}
	}
	draft, err := BeginArchitectureProposalDraft(database, "ws", "Split two responsibilities")
	if err != nil {
		t.Fatal(err)
	}
	first := []DraftSystem{{SystemKey: "parent", Name: "Parent", Files: []string{"a.go"}}}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "part-1", first); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	resumed, err := GetArchitectureProposalDraft(database, draft.ID, "ws")
	if err != nil || resumed.ChunkCount != 1 || len(resumed.Systems) != 1 {
		t.Fatalf("resumed draft = %#v, %v", resumed, err)
	}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "part-1", first); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "part-1", []DraftSystem{{SystemKey: "different", Name: "Different"}}); err == nil {
		t.Fatal("changed chunk retry should conflict")
	}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "part-2", []DraftSystem{{SystemKey: "child", Name: "Child", ParentKey: "parent", Files: []string{"b.go"}}}); err != nil {
		t.Fatal(err)
	}
	if systems, err := GetSystems(database, "ws"); err != nil || len(systems) != 0 {
		t.Fatalf("draft leaked into live map: %#v, %v", systems, err)
	}
	proposal, err := CommitArchitectureProposalDraft(database, draft.ID, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if proposal.ID != draft.ID || len(proposal.Round.Systems) != 2 || proposal.Round.Systems[1].Depth != 1 {
		t.Fatalf("proposal = %#v", proposal)
	}
	if _, err := CommitArchitectureProposalDraft(database, draft.ID, "ws"); err != nil {
		t.Fatalf("idempotent commit: %v", err)
	}
	if systems, err := GetSystems(database, "ws"); err != nil || len(systems) != 0 {
		t.Fatalf("unreviewed proposal leaked into live map: %#v, %v", systems, err)
	}
}

func TestArchitectureProposalDraftReportsIncompleteMapWithoutClosingIt(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "draft test"}); err != nil {
		t.Fatal(err)
	}
	draft, err := BeginArchitectureProposalDraft(database, "ws", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "bad", []DraftSystem{{SystemKey: "x", Name: "X", Files: []string{"../escape.go"}}}); err == nil {
		t.Fatal("unsafe path accepted")
	}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "missing-file", []DraftSystem{{SystemKey: "x", Name: "X", Files: []string{"missing.go"}}}); err == nil || !strings.Contains(err.Error(), "missing.go") {
		t.Fatalf("missing path error = %v", err)
	}
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "part", []DraftSystem{{SystemKey: "child", Name: "Child", ParentKey: "missing"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := CommitArchitectureProposalDraft(database, draft.ID, "ws"); err == nil || !strings.Contains(err.Error(), "parent") {
		t.Fatalf("missing parent error = %v", err)
	}
	status, err := GetArchitectureProposalDraft(database, draft.ID, "ws")
	if err != nil || status.Status != "open" {
		t.Fatalf("failed commit closed draft: %#v, %v", status, err)
	}
	if err := AbortArchitectureProposalDraft(database, draft.ID, "ws"); err != nil {
		t.Fatal(err)
	}
	aborted, err := GetArchitectureProposalDraft(database, draft.ID, "ws")
	if err != nil || aborted.ChunkCount != 0 {
		t.Fatalf("aborted draft retained chunks: %#v, %v", aborted, err)
	}
	if _, err := CommitArchitectureProposalDraft(database, draft.ID, "ws"); err == nil {
		t.Fatal("aborted draft committed")
	}
}
