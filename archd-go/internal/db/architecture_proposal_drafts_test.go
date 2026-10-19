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
	// A file that cannot be placed is left out and reported; the chunk lands.
	withMissing, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "missing-file", []DraftSystem{{SystemKey: "x", Name: "X", Files: []string{"missing.go"}}})
	if err != nil {
		t.Fatalf("chunk with an unindexed file: %v", err)
	}
	if len(withMissing.Skipped) != 1 || withMissing.Skipped[0].Path != "missing.go" || withMissing.Skipped[0].SystemKey != "x" || withMissing.Skipped[0].Reason != DraftFileNotIndexed {
		t.Fatalf("skipped = %#v", withMissing.Skipped)
	}
	if len(withMissing.Systems) != 1 || len(withMissing.Systems[0].Files) != 0 {
		t.Fatalf("unindexed file was stored: %#v", withMissing.Systems)
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

func TestArchitectureProposalDraftChunkSkipsUnplaceableFiles(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "draft test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	for file, language := range map[string]string{"a.go": "go", "b.go": "go", "README.md": "markdown"} {
		if err := UpsertFile(database, File{ID: file, RootID: "root", Path: file, RelPath: file, Language: language}); err != nil {
			t.Fatal(err)
		}
	}
	draft, err := BeginArchitectureProposalDraft(database, "ws", "")
	if err != nil {
		t.Fatal(err)
	}
	first := []DraftSystem{{SystemKey: "core", Name: "Core", Files: []string{"a.go", "schema.sql", "README.md"}}}
	added, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "one", first)
	if err != nil {
		t.Fatal(err)
	}
	if len(added.Systems) != 1 || len(added.Systems[0].Files) != 1 || added.Systems[0].Files[0] != "a.go" {
		t.Fatalf("kept files = %#v", added.Systems)
	}
	reasons := map[string]string{}
	for _, skipped := range added.Skipped {
		reasons[skipped.Path] = skipped.Reason
	}
	if len(reasons) != 2 || reasons["schema.sql"] != DraftFileNotIndexed || !strings.Contains(reasons["README.md"], "Documents") {
		t.Fatalf("skipped = %#v", added.Skipped)
	}
	// The same request again is the same chunk, and says the same thing.
	retried, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "one", first)
	if err != nil || retried.ChunkCount != 1 || len(retried.Skipped) != 2 {
		t.Fatalf("retry = %#v, %v", retried, err)
	}
	// A file another chunk already placed stays where it is.
	second, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "two", []DraftSystem{{SystemKey: "edge", Name: "Edge", Files: []string{"a.go", "b.go"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Skipped) != 1 || second.Skipped[0].Path != "a.go" || !strings.Contains(second.Skipped[0].Reason, "Core") {
		t.Fatalf("duplicate skipped = %#v", second.Skipped)
	}
	if files := second.Systems[1].Files; len(files) != 1 || files[0] != "b.go" {
		t.Fatalf("second chunk files = %#v", files)
	}
}

func TestArchitectureProposalDraftLeavesOutSystemsWithNoIndexedFiles(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "draft test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertFile(database, File{ID: "api.go", RootID: "root", Path: "api.go", RelPath: "api.go", Language: "go"}); err != nil {
		t.Fatal(err)
	}
	draft, err := BeginArchitectureProposalDraft(database, "ws", "API and its config")
	if err != nil {
		t.Fatal(err)
	}
	// "Config" is made only of a file Ambio does not index; "Server" holds a
	// subsystem with a file, so it stays although it owns none itself.
	if _, err := AddArchitectureProposalDraftChunk(database, draft.ID, "ws", "part-1", []DraftSystem{
		{SystemKey: "server", Name: "Server"},
		{SystemKey: "api", Name: "API", ParentKey: "server", Files: []string{"api.go"}},
		{SystemKey: "config", Name: "Config", ParentKey: "server", Files: []string{"settings.json"}},
	}); err != nil {
		t.Fatal(err)
	}
	proposal, err := CommitArchitectureProposalDraft(database, draft.ID, "ws")
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	for _, system := range proposal.Round.Systems {
		kept = append(kept, system.SystemKey)
	}
	if strings.Join(kept, ",") != "server,api" {
		t.Fatalf("kept systems = %v, want server and api", kept)
	}
	if strings.Join(proposal.Round.DroppedSystems, ",") != "Config" {
		t.Fatalf("dropped systems = %v, want Config", proposal.Round.DroppedSystems)
	}
}
