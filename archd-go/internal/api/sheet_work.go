package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"axiom.local/archd/internal/db"
)

// Comparison and checked archival share one SQLite transaction. A resolution
// retains its context and evidence; it never deletes the sheet or user work.
func (s *Server) handleSheetWork(w http.ResponseWriter, r *http.Request, id, op string) {
	workspace := r.URL.Query().Get("workspace")
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Revision    int    `json:"revision"`
		Token       string `json:"token"`
		PlannedID   string `json:"plannedId"`
		LiveID      string `json:"liveId"`
		NodeID      string `json:"nodeId"`
	}
	if r.Method == "POST" {
		if !decodeInbox(w, r, &body) {
			return
		}
		workspace = body.WorkspaceID
	} else if r.Method != "GET" || (op != "compare" && op != "context") {
		http.NotFound(w, r)
		return
	}
	d, err := s.dbFor(workspace)
	if err != nil {
		inboxError(w, err)
		return
	}
	if op == "bind" {
		if err = db.BindSheetNode(d, workspace, id, body.PlannedID, body.LiveID, body.Revision); err != nil {
			inboxError(w, err)
			return
		}
		sheet, _ := db.GetSheet(d, id)
		s.broadcastPatch("sheet:upserted", sheet)
		jsonOK(w, sheet)
		return
	}
	if op == "apply_nesting" {
		result, err := db.ApplySheetNesting(d, workspace, id, body.NodeID, body.Revision, body.Token)
		if err != nil {
			inboxError(w, err)
			return
		}
		s.broadcastPatch("floor:layouts", result, workspace)
		jsonOK(w, result)
		return
	}
	if op == "resolve" {
		// Re-evaluate supported contracts against source before accepting a green
		// status. A claimed realization flag is not implementation evidence.
		changed, err := db.ReconcilePlanned(d, workspace)
		if err != nil {
			inboxError(w, err)
			return
		}
		for _, node := range changed {
			s.broadcastPatch("planned:upserted", node)
		}
	}
	tx, err := d.Begin()
	if err != nil {
		inboxError(w, err)
		return
	}
	defer tx.Rollback()
	sheet, err := db.GetSheet(tx, id)
	if err != nil {
		inboxError(w, err)
		return
	}
	if sheet == nil || sheet.WorkspaceID != workspace {
		inboxError(w, sql.ErrNoRows)
		return
	}
	if op == "reopen" {
		if sheet.Revision != body.Revision {
			inboxError(w, db.ErrInboxConflict)
			return
		}
		if sheet.ResolvedAt != nil {
			_, err = tx.Exec(`UPDATE sheets SET revision=revision+1,updated_at=? WHERE id=?`, time.Now().UnixMilli(), id)
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			inboxError(w, err)
			return
		}
		sheet, _ = db.GetSheet(d, id)
		s.broadcastPatch("sheet:upserted", sheet)
		jsonOK(w, sheet)
		return
	}
	comparison, err := db.CompareSheetStructure(tx, workspace, id)
	if err != nil {
		inboxError(w, err)
		return
	}
	if op == "compare" {
		jsonOK(w, comparison)
		return
	}
	if op == "context" {
		context, err := renderAgentSheetContext(tx, sheet, true)
		if err != nil {
			inboxError(w, err)
			return
		}
		result := map[string]any{"sheet": sheet, "context": json.RawMessage(context), "comparison": comparison}
		if sheet.ResolvedAt != nil {
			var savedContext, savedComparison string
			if err = tx.QueryRow(`SELECT context,comparison FROM sheet_resolutions WHERE sheet_id=? AND revision=?`, id, sheet.Revision).Scan(&savedContext, &savedComparison); err != nil {
				inboxError(w, err)
				return
			}
			result["resolvedContext"] = json.RawMessage(savedContext)
			result["resolvedComparison"] = json.RawMessage(savedComparison)
		}
		jsonOK(w, result)
		return
	}
	if op != "resolve" {
		http.NotFound(w, r)
		return
	}
	// Identical resolve retries succeed even after their response was lost.
	if sheet.ResolvedAt != nil && sheet.Revision == body.Revision {
		var saved string
		if err = tx.QueryRow(`SELECT comparison FROM sheet_resolutions WHERE sheet_id=? AND revision=?`, id, body.Revision).Scan(&saved); err != nil {
			inboxError(w, err)
			return
		}
		var prior db.SheetComparison
		if json.Unmarshal([]byte(saved), &prior) != nil || prior.Token != body.Token {
			inboxError(w, db.ErrInboxConflict)
			return
		}
		jsonOK(w, sheet)
		return
	}
	if sheet.Revision != body.Revision || comparison.Token != body.Token || !comparison.Equivalent {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": "Sheet or live structure changed, or requirements remain. Read compare again before resolving.", "comparison": comparison})
		return
	}
	context, err := renderAgentSheetContext(tx, sheet, true)
	if err != nil {
		inboxError(w, err)
		return
	}
	encoded, err := json.Marshal(comparison)
	if err != nil {
		inboxError(w, err)
		return
	}
	_, err = tx.Exec(`INSERT INTO sheet_resolutions(sheet_id,revision,resolved_at,comparison,context) VALUES(?,?,?,?,?)`, id, body.Revision, time.Now().UnixMilli(), string(encoded), context)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		inboxError(w, err)
		return
	}
	sheet, _ = db.GetSheet(d, id)
	s.broadcastPatch("sheet:upserted", sheet)
	jsonOK(w, sheet)
}
