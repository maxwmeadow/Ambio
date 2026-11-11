package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"ambio.local/archd/internal/db"
)

func TestCreateSheetFromSelectionSavesGeometryWithoutProposingANewParent(t *testing.T) {
	server, mux, _ := inboxServer(t)
	database, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	parent := "parent"
	for _, system := range []db.System{
		{ID: parent, WorkspaceID: "ws", Name: "Parent", Source: "user"},
		{ID: "child", WorkspaceID: "ws", Name: "Child", ParentID: &parent, Source: "user"},
	} {
		if err := db.UpsertSystem(database, system); err != nil {
			t.Fatal(err)
		}
	}
	initial := db.SheetLayout{NodeID: "child", NodeType: "system", Width: 420, Height: 240, Scale: 0.75, InteriorScale: 0.5}
	body := map[string]any{
		"workspaceId": "ws", "name": "Child scope",
		"elements": []map[string]string{{"systemId": "child"}},
		"layouts":  []db.SheetLayout{initial},
	}
	response := inboxHTTP(t, mux, http.MethodPost, "/api/sheets", body)
	if response.Code != http.StatusOK {
		t.Fatalf("create returned %d: %s", response.Code, response.Body.String())
	}
	var sheet db.Sheet
	if err := json.Unmarshal(response.Body.Bytes(), &sheet); err != nil {
		t.Fatal(err)
	}
	if err := db.RepairUnplacedSheetLayouts(database); err != nil {
		t.Fatal(err)
	}
	response = inboxHTTP(t, mux, http.MethodGet, "/api/sheets/"+sheet.ID+"?workspace=ws", nil)
	var loaded struct {
		Sheet   db.Sheet
		Layouts []db.SheetLayout
	}
	if err := json.Unmarshal(response.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	if len(loaded.Layouts) != 1 || loaded.Sheet.Revision != sheet.Revision {
		t.Fatalf("created and reopened sheet disagree: %#v", loaded)
	}
	layout := loaded.Layouts[0]
	if layout.PositionX != 0 || layout.PositionY != 0 || layout.ParentNodeID != nil || layout.Width != initial.Width ||
		layout.Height != initial.Height || layout.Scale != initial.Scale || layout.InteriorScale != initial.InteriorScale || !layout.PresentationOnly {
		t.Fatalf("initial selection layout changed: %#v", layout)
	}
	comparison, err := db.CompareSheetStructure(database, "ws", sheet.ID)
	if err != nil || !comparison.Equivalent || len(comparison.Nodes) != 1 || comparison.Nodes[0].ParentID != parent {
		t.Fatalf("selection became a structural change: %#v, %v", comparison, err)
	}
	initial.PositionX = 25
	result, err := db.ApplySheetLayoutBatch(database, sheet.ID, "ws", []db.SheetLayout{initial})
	if err != nil || !result.Layouts[0].PresentationOnly {
		t.Fatalf("moving within the sheet changed containment intent: %#v, %v", result, err)
	}
	initial.NodeID = "missing"
	body["name"] = "Invalid scope"
	body["layouts"] = []db.SheetLayout{initial}
	response = inboxHTTP(t, mux, http.MethodPost, "/api/sheets", body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid layout returned %d: %s", response.Code, response.Body.String())
	}
	if exists, err := db.SheetNameTaken(database, "ws", "Invalid scope", ""); err != nil || exists {
		t.Fatalf("failed selection creation left a sheet behind: exists=%v err=%v", exists, err)
	}
}
