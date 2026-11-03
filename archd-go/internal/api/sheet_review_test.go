package api

import (
	"ambio.local/archd/internal/db"
	"encoding/json"
	"net/http"
	"testing"
)

func TestSheetReviewHTTPReturnsTheApprovedSnapshotAndRejectsStaleScope(t *testing.T) {
	server, mux, _ := inboxServer(t)
	database, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	sheet := db.Sheet{ID: "review", WorkspaceID: "ws", Name: "Replay"}
	if err := db.CreateSheet(database, &sheet); err != nil {
		t.Fatal(err)
	}
	node := db.PlannedNode{ID: "tool", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "system", Name: "Replay tool", CreatedBy: "agent"}
	if err := db.UpsertPlannedNode(database, &node); err != nil {
		t.Fatal(err)
	}
	current, err := db.GetSheet(database, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"workspaceId": "ws", "revision": current.Revision - 1, "choices": []db.SheetProposalChoice{{Kind: "addition", ID: node.ID}}, "decision": "approved"}
	if response := inboxHTTP(t, mux, http.MethodPost, "/api/sheets/review/review", body); response.Code != 409 {
		t.Fatalf("stale scope returned %d: %s", response.Code, response.Body.String())
	}
	body["revision"] = current.Revision
	response := inboxHTTP(t, mux, http.MethodPost, "/api/sheets/review/review", body)
	if response.Code != 200 {
		t.Fatalf("review returned %d: %s", response.Code, response.Body.String())
	}
	var result db.SheetReviewResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Sheet.Revision <= current.Revision || len(result.Planned) != 1 || result.Planned[0].ApprovalStatus != "approved" {
		t.Fatalf("invalid approved snapshot: %#v", result)
	}
	if response := inboxHTTP(t, mux, http.MethodPost, "/api/sheets/review/review", body); response.Code != 409 {
		t.Fatalf("stale retry returned %d", response.Code)
	}
}
