package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// WorkOrderSnapshotComparison checks the structural target frozen when a work
// order was sent. It never resolves or edits the current sheet.
type WorkOrderSnapshotComparison struct {
	MessageID            string            `json:"messageId"`
	SheetID              string            `json:"sheetId"`
	Name                 string            `json:"name"`
	Revision             int               `json:"revision"`
	CurrentSheetRevision int               `json:"currentSheetRevision,omitempty"`
	Equivalent           bool              `json:"equivalent"`
	Checked              int               `json:"checked"`
	Differences          []SheetDifference `json:"differences"`
	Mappings             map[string]string `json:"mappings"`
}

type frozenSheetNode struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Type           string          `json:"type"`
	Planned        bool            `json:"planned"`
	ApprovalStatus string          `json:"approvalStatus"`
	DeclaredPath   string          `json:"declaredPath"`
	Metadata       json.RawMessage `json:"metadata"`
	Members        json.RawMessage `json:"members"`
}
type frozenSheetEdge struct {
	Kind     string `json:"kind"`
	SourceID string `json:"sourceId"`
	TargetID string `json:"targetId"`
	Planned  bool   `json:"planned"`
}
type frozenSheetContext struct {
	Sheet struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Revision int    `json:"revision"`
	} `json:"sheet"`
	Nodes            []frozenSheetNode `json:"nodes"`
	Edges            []frozenSheetEdge `json:"edges"`
	Removals         []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Name string `json:"name"`
	} `json:"removals"`
	ComparisonAtSend struct {
		Nodes    []StructureNode   `json:"nodes"`
		Mappings map[string]string `json:"mappings"`
	} `json:"comparisonAtSend"`
}

func contractMetadata(raw json.RawMessage) string {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return string(raw)
	}
	delete(object, "realization")
	encoded, _ := json.Marshal(object)
	return string(encoded)
}

func CompareWorkOrderSnapshot(r Reader, workspace string, message *CanvasMessage) (*WorkOrderSnapshotComparison, error) {
	if message == nil || message.WorkspaceID != workspace || message.SheetID == nil {
		return nil, sql.ErrNoRows
	}
	var frozen frozenSheetContext
	if err := json.Unmarshal([]byte(message.SheetContext), &frozen); err != nil {
		return &WorkOrderSnapshotComparison{
			MessageID: message.ID, SheetID: *message.SheetID, Differences: []SheetDifference{{
				Kind: "unverifiable", NodeID: message.ID, Name: "Sent sheet", Detail: "This older work order has no readable structural snapshot",
			}}, Mappings: map[string]string{},
		}, nil
	}
	c := &WorkOrderSnapshotComparison{
		MessageID: message.ID, SheetID: *message.SheetID, Name: frozen.Sheet.Name, Revision: frozen.Sheet.Revision,
		Differences: []SheetDifference{}, Mappings: map[string]string{},
	}
	add := func(kind, id, name, expected, actual, detail string) {
		c.Differences = append(c.Differences, SheetDifference{Kind: kind, NodeID: id, Name: name, Expected: expected, Actual: actual, Detail: detail})
	}
	if frozen.Sheet.ID != *message.SheetID || frozen.Sheet.Revision < 1 {
		add("unverifiable", message.ID, frozen.Sheet.Name, "", "", "The saved sheet identity is incomplete")
	}
	if sheet, err := GetSheet(r, *message.SheetID); err != nil {
		return nil, err
	} else if sheet != nil && sheet.WorkspaceID == workspace {
		c.CurrentSheetRevision = sheet.Revision
	}
	live, files, err := loadLiveStructure(r, workspace)
	if err != nil {
		return nil, err
	}
	deps, err := GetDependencies(r, workspace)
	if err != nil {
		return nil, err
	}
	frozenPlans := map[string]frozenSheetNode{}
	for _, node := range frozen.Nodes {
		if node.Planned {
			frozenPlans[node.ID] = node
		}
	}
	currentPlans := map[string]PlannedNode{}
	for _, node := range frozen.ComparisonAtSend.Nodes {
		if !strings.HasPrefix(node.ID, "planned:") {
			c.Mappings[node.ID] = node.ID
		}
	}
	if c.CurrentSheetRevision > 0 {
		plans, err := GetPlannedNodes(r, *message.SheetID)
		if err != nil {
			return nil, err
		}
		for _, plan := range plans {
			currentPlans["planned:"+plan.ID] = plan
		}
	}
	bindings := map[string]string{}
	rows, err := r.Query(`SELECT planned_id,live_id FROM sheet_bindings WHERE sheet_id=?`, *message.SheetID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var plannedID, liveID string
		if err := rows.Scan(&plannedID, &liveID); err != nil {
			rows.Close()
			return nil, err
		}
		bindings["planned:"+plannedID] = liveID
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, desired := range frozen.ComparisonAtSend.Nodes {
		if !strings.HasPrefix(desired.ID, "planned:") {
			continue
		}
		plan, ok := frozenPlans[desired.ID]
		if !ok {
			add("unverifiable", desired.ID, desired.Name, "", "", "The sent plan lacks this proposed element's definition")
			continue
		}
		if plan.ApprovalStatus != "approved" {
			add("approval", desired.ID, desired.Name, "approved", plan.ApprovalStatus, "This proposal was not approved when the work order was sent")
			continue
		}
		if plannedType(plan.Type) == "file" {
			evaluated, err := evaluatePlannedNode(r, files, PlannedNode{
				ID: strings.TrimPrefix(desired.ID, "planned:"), Name: plan.Name, Kind: plan.Type,
				DeclaredPath: plan.DeclaredPath, Metadata: plan.Metadata, Members: plan.Members,
			})
			if err != nil || evaluated.Status != "realized" || evaluated.RealizedFileID == nil {
				actual := "unverified"
				if err == nil {
					actual = evaluated.Status
				}
				add("implementation", desired.ID, desired.Name, "realized", actual, "The sent file contract is not corroborated by current indexed source")
				continue
			}
			c.Mappings[desired.ID] = *evaluated.RealizedFileID
			continue
		}
		liveID := frozen.ComparisonAtSend.Mappings[desired.ID]
		if liveID == "" {
			liveID = bindings[desired.ID]
		}
		if liveID != "" && frozen.ComparisonAtSend.Mappings[desired.ID] == "" {
			current, exists := currentPlans[desired.ID]
			if !exists || current.Name != plan.Name || current.Kind != plan.Type || current.DeclaredPath != plan.DeclaredPath || contractMetadata(current.Metadata) != contractMetadata(plan.Metadata) {
				liveID = ""
				add("unverifiable", desired.ID, desired.Name, "", "", "The current binding belongs to a changed proposal; bind the original intent explicitly")
			}
		}
		if liveID == "" {
			add("create", desired.ID, desired.Name, plannedType(plan.Type), "", "The sent proposed element has no verified live binding")
			continue
		}
		if live[liveID].Type != plannedType(plan.Type) {
			add("implementation", desired.ID, desired.Name, plannedType(plan.Type), live[liveID].Type, "The bound live node is missing or has the wrong type")
			continue
		}
		c.Mappings[desired.ID] = liveID
	}
	for _, desired := range frozen.ComparisonAtSend.Nodes {
		c.Checked++
		mapped := c.Mappings[desired.ID]
		actual, ok := live[mapped]
		if !ok {
			if !strings.HasPrefix(desired.ID, "planned:") {
				add("missing", desired.ID, desired.Name, desired.Type, "", "Referenced live element no longer exists")
			}
			continue
		}
		if actual.Type != desired.Type {
			add("implementation", desired.ID, desired.Name, desired.Type, actual.Type, "The live node has a different type")
			continue
		}
		parent := desired.ParentID
		if strings.HasPrefix(parent, "planned:") {
			parent = c.Mappings[parent]
			if parent == "" {
				add("parent", desired.ID, desired.Name, desired.ParentID, actual.ParentID, "Implement and bind the sent proposed parent first")
				continue
			}
		}
		if parent != "" {
			if _, ok := live[parent]; !ok {
				add("parent", desired.ID, desired.Name, parent, actual.ParentID, "Required parent no longer exists")
				continue
			}
		}
		if actual.ParentID != parent || actual.Containment != desired.Containment {
			add("nesting", desired.ID, desired.Name, parent, actual.ParentID, "Match the sent parent and containment: "+desired.Containment+" (live: "+actual.Containment+")")
		}
	}
	for _, removal := range frozen.Removals {
		c.Checked++
		if removalPending(live, files, removal.ID, removal.Type) {
			add("removal", removal.ID, removal.Name, "removed", removal.Type, removalDetail(removal.Type))
		}
	}
	for index, edge := range frozen.Edges {
		if !edge.Planned {
			continue
		}
		if frozenPlans[edge.SourceID].ApprovalStatus == "rejected" || frozenPlans[edge.TargetID].ApprovalStatus == "rejected" {
			continue
		}
		c.Checked++
		edgeID := fmt.Sprintf("sent-edge-%d", index)
		if edge.SourceID == "" || edge.TargetID == "" {
			add("unverifiable", edgeID, edge.Kind, "", "", "This older sent relationship lacks stable endpoint IDs")
			continue
		}
		src, dst := edge.SourceID, edge.TargetID
		if strings.HasPrefix(src, "planned:") {
			src = c.Mappings[src]
		}
		if strings.HasPrefix(dst, "planned:") {
			dst = c.Mappings[dst]
		}
		if src == "" || dst == "" || live[src].ID == "" || live[dst].ID == "" {
			add("relationship", edgeID, edge.Kind, edge.SourceID+" → "+edge.TargetID, "", "The sent relationship has an unverified endpoint")
			continue
		}
		found := strings.EqualFold(edge.Kind, "CONTAINS") && live[dst].ParentID == src
		for _, dependency := range deps {
			if dependency.Src == src && dependency.Dst == dst && strings.EqualFold(dependency.DependencyType, edge.Kind) {
				found = true
				break
			}
		}
		if !found {
			add("relationship", edgeID, edge.Kind, src+" → "+dst, "", "The sent typed relationship is not present in the live model")
		}
	}
	if c.Checked == 0 {
		add("unverifiable", message.ID, frozen.Sheet.Name, "", "", "The sent plan has no structural requirements to check")
	}
	sort.Slice(c.Differences, func(i, j int) bool {
		a, b := c.Differences[i], c.Differences[j]
		return a.NodeID+a.Kind < b.NodeID+b.Kind
	})
	c.Equivalent = len(c.Differences) == 0
	return c, nil
}
