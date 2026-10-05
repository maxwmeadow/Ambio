package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"ambio.local/archd/internal/db"
)

const paymentSpec = "# Payment flow\n\n" +
	"Card payments move out of Orders.\n\n" +
	"## Context\n" +
	"- system `Orders`\n\n" +
	"## Add\n" +
	"- system `Card Payments` at `src/payments/` - takes card payments\n" +
	"  - `charge(amount: Money): Receipt` - charges the card\n" +
	"- file `Stripe client` at `src/payments/stripe.ts`\n\n" +
	"## Remove\n" +
	"- file `billing.ts`\n\n" +
	"## Connections\n" +
	"- `Orders` DEPENDS_ON `Card Payments` - checkout charges through it\n"

func TestASheetRoundTripsThroughMarkdown(t *testing.T) {
	server := meaningServer(t)
	sqlDB := mustDB(t, server)
	r := send(t, server, http.MethodPost, "/api/sheet-import", map[string]any{
		"workspaceId": "ws", "markdown": paymentSpec + "\nSome prose a person left here.\n",
	})
	if r.Code != http.StatusOK {
		t.Fatalf("import: %d %s", r.Code, r.Body.String())
	}
	var imported struct {
		Sheet    db.Sheet `json:"sheet"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &imported); err != nil {
		t.Fatal(err)
	}
	if imported.Sheet.Name != "Payment flow" || imported.Sheet.Purpose == nil || *imported.Sheet.Purpose != "Card payments move out of Orders." {
		t.Fatalf("sheet = %+v", imported.Sheet)
	}
	if len(imported.Warnings) != 1 || !strings.Contains(imported.Warnings[0], "Some prose") {
		t.Fatalf("warnings = %v", imported.Warnings)
	}
	planned, _ := db.GetPlannedNodes(sqlDB, imported.Sheet.ID)
	if len(planned) != 2 || planned[0].ApprovalStatus != "approved" {
		t.Fatalf("planned = %+v", planned)
	}
	removals, _ := db.GetSheetRemovals(sqlDB, "ws", imported.Sheet.ID)
	if len(removals) != 1 || removals[0].NodeID != "billing" {
		t.Fatalf("removals = %+v", removals)
	}

	exported := send(t, server, http.MethodGet, "/api/sheets/"+imported.Sheet.ID+"/markdown?workspace=ws", nil)
	var body struct {
		Markdown string `json:"markdown"`
	}
	_ = json.Unmarshal(exported.Body.Bytes(), &body)
	if body.Markdown != paymentSpec {
		t.Fatalf("export differs from the spec it came from:\n%s\n---\n%s", body.Markdown, paymentSpec)
	}

	// The same spec imported again gets its own name; an agent's arrives as proposals.
	r = send(t, server, http.MethodPost, "/api/sheet-import", map[string]any{"workspaceId": "ws", "markdown": paymentSpec, "createdBy": "agent"})
	_ = json.Unmarshal(r.Body.Bytes(), &imported)
	if imported.Sheet.Name != "Payment flow (2)" {
		t.Fatalf("second import named %q", imported.Sheet.Name)
	}
	planned, _ = db.GetPlannedNodes(sqlDB, imported.Sheet.ID)
	if len(planned) != 2 || planned[0].ApprovalStatus != "pending" {
		t.Fatalf("an agent's import was not a proposal: %+v", planned)
	}
}

func TestASpecNamingWhatTheMapDoesNotHaveSaysSo(t *testing.T) {
	server := meaningServer(t)
	r := send(t, server, http.MethodPost, "/api/sheet-import", map[string]any{
		"workspaceId": "ws",
		"markdown":    "## Context\n- system `Nowhere`\n## Connections\n- `Ghost` CALLS `Orders`\n",
	})
	if r.Code != http.StatusOK {
		t.Fatalf("import: %d %s", r.Code, r.Body.String())
	}
	if !strings.Contains(r.Body.String(), `\"Nowhere\" is not on the map`) || !strings.Contains(r.Body.String(), "Ghost") ||
		!strings.Contains(r.Body.String(), `"name":"Imported spec"`) {
		t.Fatalf("body = %s", r.Body.String())
	}
}
