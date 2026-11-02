package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"ambio.local/archd/internal/db"
)

func TestNotesRoundTripAndRevisionSafety(t *testing.T) {
	server, mux, _ := inboxServer(t)
	database, _ := server.dbFor("ws")
	sheet := db.Sheet{ID: "notes-sheet", WorkspaceID: "ws", Name: "Notes"}
	if err := db.CreateSheet(database, &sheet); err != nil {
		t.Fatal(err)
	}
	for _, surface := range []string{"floor", sheet.ID} {
		t.Run(surface, func(t *testing.T) {
			body := map[string]any{"workspaceId": "ws", "body": "Why this boundary exists", "author": "user", "positionX": 120, "positionY": 75}
			if surface != "floor" {
				body["sheetId"] = surface
			}
			response := inboxHTTP(t, mux, http.MethodPost, "/api/annotations", body)
			if response.Code != 200 {
				t.Fatalf("create: %d %s", response.Code, response.Body.String())
			}
			var note db.Annotation
			if err := json.Unmarshal(response.Body.Bytes(), &note); err != nil {
				t.Fatal(err)
			}
			if note.Revision != 1 || note.Width != 260 || note.Height != 180 {
				t.Fatalf("defaults: %#v", note)
			}
			path := "/api/annotations/" + note.ID + "?workspace=ws"
			edit := inboxHTTP(t, mux, http.MethodPatch, path, map[string]any{"revision": 1, "body": "Agent clarified the boundary", "updatedBy": "agent", "positionX": 240, "width": 320, "height": 220})
			if edit.Code != 200 {
				t.Fatalf("agent edit: %d %s", edit.Code, edit.Body.String())
			}
			if err := json.Unmarshal(edit.Body.Bytes(), &note); err != nil {
				t.Fatal(err)
			}
			if note.Author != "user" || note.UpdatedBy != "agent" || note.Revision != 2 || *note.PositionX != 240 || note.Width != 320 {
				t.Fatalf("edited note: %#v", note)
			}
			stale := inboxHTTP(t, mux, http.MethodPatch, path, map[string]any{"revision": 1, "body": "stale user text"})
			if stale.Code != 409 {
				t.Fatalf("stale edit: %d %s", stale.Code, stale.Body.String())
			}
			var conflict struct {
				Current db.Annotation `json:"current"`
			}
			if err := json.Unmarshal(stale.Body.Bytes(), &conflict); err != nil {
				t.Fatal(err)
			}
			if conflict.Current.Body != note.Body || conflict.Current.Revision != 2 {
				t.Fatalf("conflict lost latest note: %#v", conflict)
			}
			edit = inboxHTTP(t, mux, http.MethodPatch, path, map[string]any{"revision": 2, "body": "Human and agent agree", "updatedBy": "user"})
			if edit.Code != 200 {
				t.Fatalf("human edit: %d %s", edit.Code, edit.Body.String())
			}
			read := inboxHTTP(t, mux, http.MethodGet, "/api/annotations?workspace=ws&sheet="+surface, nil)
			var listed []db.Annotation
			if err := json.Unmarshal(read.Body.Bytes(), &listed); err != nil {
				t.Fatal(err)
			}
			if len(listed) != 1 || listed[0].Body != "Human and agent agree" {
				t.Fatalf("surface read: %s", read.Body.String())
			}
			other := inboxHTTP(t, mux, http.MethodGet, "/api/annotations?workspace=ws&sheet="+map[bool]string{true: sheet.ID, false: "floor"}[surface == "floor"], nil)
			if other.Body.String() != "[]\n" {
				t.Fatalf("surface leaked: %s", other.Body.String())
			}
			if r := inboxHTTP(t, mux, http.MethodDelete, path+"&revision=2", nil); r.Code != 409 {
				t.Fatalf("stale delete: %d", r.Code)
			}
			if r := inboxHTTP(t, mux, http.MethodDelete, path+"&revision=3", nil); r.Code != 200 {
				t.Fatalf("delete: %d %s", r.Code, r.Body.String())
			}
			if r := inboxHTTP(t, mux, http.MethodGet, path, nil); r.Code != 404 {
				t.Fatalf("deleted note still exists: %d", r.Code)
			}
		})
	}
}

func TestNotesValidateSurfaceAndGeometry(t *testing.T) {
	_, mux, _ := inboxServer(t)
	for _, body := range []map[string]any{
		{"workspaceId": "ws", "body": "text", "sheetId": "missing"},
		{"workspaceId": "ws", "body": " "},
		{"workspaceId": "ws", "body": "text", "width": 20},
		{"workspaceId": "ws", "body": "text", "author": "someone"},
	} {
		if r := inboxHTTP(t, mux, http.MethodPost, "/api/annotations", body); r.Code < 400 {
			t.Fatalf("invalid note accepted: %v", body)
		}
	}
}
