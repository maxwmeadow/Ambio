package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestProposalDraftAPIChunksCommitIntoReviewOnly(t *testing.T) {
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertFile(sqlDB, db.File{ID: "file", RootID: "root", Path: "a.go", RelPath: "a.go", Language: "go"}); err != nil {
		t.Fatal(err)
	}
	post := func(url string, body any, handler http.HandlerFunc) *httptest.ResponseRecorder {
		t.Helper()
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler(response, httptest.NewRequest(http.MethodPost, url, bytes.NewReader(payload)))
		return response
	}
	begin := post("/api/architecture-proposal-drafts", map[string]any{"workspaceId": "ws", "rationale": "group files"}, server.handleArchitectureProposalDrafts)
	if begin.Code != http.StatusOK {
		t.Fatalf("begin %d: %s", begin.Code, begin.Body.String())
	}
	var draft struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(begin.Body.Bytes(), &draft); err != nil {
		t.Fatal(err)
	}
	chunk := post("/api/architecture-proposal-drafts/"+draft.SessionID+"/chunks", map[string]any{
		"workspaceId": "ws", "chunkId": "first", "systems": []map[string]any{{"systemKey": "core", "name": "Core", "files": []string{"a.go"}}},
	}, server.handleArchitectureProposalDraftByID)
	if chunk.Code != http.StatusOK {
		t.Fatalf("chunk %d: %s", chunk.Code, chunk.Body.String())
	}
	if systems, err := db.GetSystems(sqlDB, "ws"); err != nil || len(systems) != 0 {
		t.Fatalf("draft reached live map: %#v, %v", systems, err)
	}
	commit := post("/api/architecture-proposal-drafts/"+draft.SessionID+"/commit", map[string]string{"workspaceId": "ws"}, server.handleArchitectureProposalDraftByID)
	if commit.Code != http.StatusOK {
		t.Fatalf("commit %d: %s", commit.Code, commit.Body.String())
	}
	proposal, err := db.GetArchitectureProposal(sqlDB, draft.SessionID, "ws", false)
	if err != nil || len(proposal.Round.Systems) != 1 {
		t.Fatalf("committed proposal = %#v, %v", proposal, err)
	}
	if systems, err := db.GetSystems(sqlDB, "ws"); err != nil || len(systems) != 0 {
		t.Fatalf("proposal bypassed review: %#v, %v", systems, err)
	}
}
