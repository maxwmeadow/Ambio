package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SheetProposalChoice identifies the exact requirements the person reviewed.
// Groups are presentation; decisions remain on their original nodes and edges.
type SheetProposalChoice struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type SheetReviewResult struct {
	Sheet        *Sheet        `json:"sheet"`
	Planned      []PlannedNode `json:"planned"`
	PlannedEdges []PlannedEdge `json:"plannedEdges"`
}

func DecideSheetProposals(database *sql.DB, workspaceID, sheetID string, revision int, choices []SheetProposalChoice, decision, reason string) (*SheetReviewResult, error) {
	if decision != "approved" && decision != "rejected" {
		return nil, fmt.Errorf("decision must be approved or rejected")
	}
	if len(choices) == 0 || len(choices) > 1000 || len(reason) > 2000 {
		return nil, fmt.Errorf("select 1–1000 proposal details and a short reason")
	}
	rootID, branch := completeHistoryIdentity(database, workspaceID, "", "")
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	sheet, err := GetSheet(tx, sheetID)
	if err != nil || sheet == nil || sheet.WorkspaceID != workspaceID || sheet.ResolvedAt != nil {
		return nil, fmt.Errorf("active sheet not found in this project")
	}
	if sheet.Revision != revision {
		return nil, fmt.Errorf("the plan changed; refresh and review its current details")
	}
	nodes, err := GetPlannedNodes(tx, sheetID)
	if err != nil {
		return nil, err
	}
	edges, err := GetPlannedEdges(tx, sheetID)
	if err != nil {
		return nil, err
	}
	nodeByID := map[string]PlannedNode{}
	edgeByID := map[string]PlannedEdge{}
	for _, node := range nodes {
		nodeByID[node.ID] = node
	}
	for _, edge := range edges {
		edgeByID[edge.ID] = edge
	}
	selected := map[string]bool{}
	for _, choice := range choices {
		key := choice.Kind + ":" + choice.ID
		if selected[key] {
			return nil, fmt.Errorf("duplicate proposal detail")
		}
		selected[key] = true
		switch choice.Kind {
		case "addition":
			node, ok := nodeByID[choice.ID]
			if !ok || node.ApprovalStatus != "pending" {
				return nil, fmt.Errorf("an addition is no longer awaiting review")
			}
		case "relationship":
			edge, ok := edgeByID[choice.ID]
			if !ok || edge.ApprovalStatus != "pending" {
				return nil, fmt.Errorf("a connection is no longer awaiting review")
			}
		default:
			return nil, fmt.Errorf("unsupported proposal detail")
		}
	}
	approved := func(id string) bool {
		node, ok := nodeByID[id]
		if !ok {
			return false
		}
		if selected["addition:"+id] {
			return decision == "approved"
		}
		return node.ApprovalStatus == "approved"
	}
	// A partial decision must not authorize an orphaned child or connection.
	for _, node := range nodes {
		if !approved(node.ID) || node.ParentSystemID == nil || !strings.HasPrefix(*node.ParentSystemID, "planned:") {
			continue
		}
		if !approved(strings.TrimPrefix(*node.ParentSystemID, "planned:")) {
			return nil, fmt.Errorf("review the planned parent of %s together with this change", node.Name)
		}
	}
	for _, edge := range edges {
		active := edge.ApprovalStatus == "approved"
		if selected["relationship:"+edge.ID] {
			active = decision == "approved"
		}
		if !active {
			continue
		}
		for _, endpoint := range []*string{edge.SrcPlanned, edge.DstPlanned} {
			if endpoint != nil && !approved(*endpoint) {
				return nil, fmt.Errorf("review the connection and its planned endpoints together")
			}
		}
	}
	for _, choice := range choices {
		label, kind, table := "", "planned element", "planned_nodes"
		if choice.Kind == "addition" {
			label = nodeByID[choice.ID].Name
		} else {
			label, kind, table = "Proposed connection", "relationship", "planned_edges"
		}
		// table is chosen only from the two literals above, never from input.
		if _, err := tx.Exec("UPDATE "+table+" SET approval_status=? WHERE id=? AND sheet_id=?", decision, choice.ID, sheetID); err != nil {
			return nil, err
		}
		detail, _ := json.Marshal(map[string]string{"decision": decision, "reason": strings.TrimSpace(reason), "kind": kind, "where": sheet.Name, "sheetId": sheetID})
		if _, err := tx.Exec(`INSERT INTO structural_events
		 (workspace_id,root_id,branch,ts,actor,trace_id,kind,subject_id,subject_label,object_id,object_label,detail,count,session_id)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, workspaceID, nullableHistoryIdentity(rootID), nullableHistoryIdentity(branch), time.Now().UnixMilli(), "human", "", EventProposalDecided, choice.ID, label, "", "", string(detail), ""); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE sheets SET revision=revision+1, updated_at=? WHERE id=?`, time.Now().UnixMilli(), sheetID); err != nil {
		return nil, err
	}
	sheet, err = GetSheet(tx, sheetID)
	if err != nil {
		return nil, err
	}
	nodes, err = GetPlannedNodes(tx, sheetID)
	if err != nil {
		return nil, err
	}
	edges, err = GetPlannedEdges(tx, sheetID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SheetReviewResult{Sheet: sheet, Planned: nodes, PlannedEdges: edges}, nil
}
