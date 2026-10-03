package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
)

// Watching a function over HTTP: it resolves against the index (preferring a
// callable over a same-named variable), shows in the snapshot, says when no
// process is connected yet, and goes away when unwatched.
func TestAWatchIsResolvedListedAndRemoved(t *testing.T) {
	server := meaningServer(t)
	sqlDB := mustDB(t, server)
	if err := db.UpsertSymbols(sqlDB, "billing", []db.Symbol{
		{ID: "v", Name: "charge", Kind: "variable", LineStart: 1, LineEnd: 1},
		{ID: "f", Name: "charge", Kind: "function", LineStart: 3, LineEnd: 9},
	}); err != nil {
		t.Fatal(err)
	}

	missing := send(t, server, http.MethodPost, "/api/runtime/watch", map[string]any{"workspaceId": "ws", "file": "billing.ts", "symbol": "refund"})
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "Available symbols: charge") {
		t.Fatalf("missing symbol: %d %s", missing.Code, missing.Body.String())
	}

	r := send(t, server, http.MethodPost, "/api/runtime/watch", map[string]any{"workspaceId": "ws", "file": "billing.ts", "symbol": "charge"})
	if r.Code != http.StatusOK {
		t.Fatalf("watch: %d %s", r.Code, r.Body.String())
	}
	var watched struct {
		Watch struct {
			ID        string `json:"id"`
			FileID    string `json:"fileId"`
			LineStart int    `json:"lineStart"`
		} `json:"watch"`
		SessionsNotified int    `json:"sessionsNotified"`
		Note             string `json:"note"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &watched)
	if watched.Watch.FileID != "billing" || watched.Watch.LineStart != 3 {
		t.Fatalf("the function, not the variable, should be watched: %+v", watched.Watch)
	}
	if watched.SessionsNotified != 0 || !strings.Contains(watched.Note, "no runtime adapter is connected") {
		t.Fatalf("note = %q", watched.Note)
	}

	snapshot := send(t, server, http.MethodGet, "/api/runtime/snapshot?workspace=ws", nil)
	if !strings.Contains(snapshot.Body.String(), watched.Watch.ID) {
		t.Fatalf("snapshot does not list the watch: %s", snapshot.Body.String())
	}
	if bad := send(t, server, http.MethodGet, "/api/runtime/snapshot", nil); bad.Code != http.StatusBadRequest {
		t.Fatalf("snapshot without a workspace: %d", bad.Code)
	}

	if r := send(t, server, http.MethodPost, "/api/runtime/unwatch", map[string]any{"workspaceId": "ws", "watchId": watched.Watch.ID}); r.Code != http.StatusOK {
		t.Fatalf("unwatch: %d %s", r.Code, r.Body.String())
	}
	if after := send(t, server, http.MethodGet, "/api/runtime/snapshot?workspace=ws", nil); strings.Contains(after.Body.String(), watched.Watch.ID) {
		t.Fatalf("the watch is still listed: %s", after.Body.String())
	}
}
