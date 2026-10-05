package db

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

func migrateSheetWork(d *sql.DB) error {
	_, err := d.Exec(`CREATE TABLE IF NOT EXISTS sheet_resolutions (
	 sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
	 revision INTEGER NOT NULL, resolved_at INTEGER NOT NULL,
	 comparison TEXT NOT NULL, context TEXT NOT NULL,
	 PRIMARY KEY(sheet_id,revision));
	 CREATE TABLE IF NOT EXISTS sheet_bindings (
	 sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
	 planned_id TEXT NOT NULL REFERENCES planned_nodes(id) ON DELETE CASCADE,
	 live_id TEXT NOT NULL, node_type TEXT NOT NULL,
	 PRIMARY KEY(sheet_id,planned_id), UNIQUE(sheet_id,live_id));
	 CREATE TRIGGER IF NOT EXISTS sheet_edge_insert_revision AFTER INSERT ON planned_edges BEGIN
	 UPDATE sheets SET revision=revision+1 WHERE id=NEW.sheet_id; END;
	 CREATE TRIGGER IF NOT EXISTS sheet_edge_update_revision AFTER UPDATE ON planned_edges BEGIN
	 UPDATE sheets SET revision=revision+1 WHERE id=NEW.sheet_id; END;
	 CREATE TRIGGER IF NOT EXISTS sheet_edge_delete_revision AFTER DELETE ON planned_edges BEGIN
	 UPDATE sheets SET revision=revision+1 WHERE id=OLD.sheet_id; END;`)
	return err
}

type StructureNode struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	ParentID    string `json:"parentId"`
	Containment string `json:"containment"`
}
type SheetDifference struct {
	Kind     string `json:"kind"`
	NodeID   string `json:"nodeId"`
	Name     string `json:"name"`
	Expected string `json:"expected,omitempty"`
	Actual   string `json:"actual,omitempty"`
	Detail   string `json:"detail"`
}
type SheetComparison struct {
	SheetID     string            `json:"sheetId"`
	WorkspaceID string            `json:"workspaceId"`
	Name        string            `json:"name"`
	Revision    int               `json:"revision"`
	Token       string            `json:"token"`
	Equivalent  bool              `json:"equivalent"`
	ResolvedAt  *int64            `json:"resolvedAt,omitempty"`
	Checked     int               `json:"checked"`
	Differences []SheetDifference `json:"differences"`
	Nodes       []StructureNode   `json:"nodes"`
	Mappings    map[string]string `json:"mappings"`
	// Removals are the live nodes the sheet proposes taking away.
	Removals []string `json:"removals,omitempty"`
}

func removalDetail(nodeType string) string {
	if nodeType == "system" {
		return "Remove this system's code; the sheet proposes it should no longer exist"
	}
	return "Remove this from the code; the sheet proposes it should no longer exist"
}

func refValue(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func plannedType(kind string) string {
	if kind == "system" || kind == "infra" {
		return kind
	}
	return "file"
}
func containment(parent, parentType string) string {
	if parent == "" {
		return "root"
	}
	if parentType == "infra" {
		return "hosted_by"
	}
	return "part_of"
}

func loadLiveStructure(r Reader, workspace string) (map[string]StructureNode, []File, error) {
	files, err := GetFiles(r, workspace)
	if err != nil {
		return nil, nil, err
	}
	systems, err := GetSystems(r, workspace)
	if err != nil {
		return nil, nil, err
	}
	infras, err := GetInfraNodes(r, workspace)
	if err != nil {
		return nil, nil, err
	}
	floor, err := GetFloorLayouts(r, workspace)
	if err != nil {
		return nil, nil, err
	}
	live := map[string]StructureNode{}
	for _, f := range files {
		live[f.ID] = StructureNode{f.ID, "file", f.RelPath, refValue(f.SystemID), containment(refValue(f.SystemID), "system")}
	}
	for _, s := range systems {
		live[s.ID] = StructureNode{s.ID, "system", s.Name, refValue(s.ParentID), containment(refValue(s.ParentID), "system")}
	}
	for _, i := range infras {
		live[i.ID] = StructureNode{i.ID, "infra", i.Name, "", "root"}
	}
	for _, l := range floor {
		if n, ok := live[l.NodeID]; ok {
			n.ParentID = refValue(l.ParentNodeID)
			n.Containment = l.ContainmentKind
			live[n.ID] = n
		}
	}
	return live, files, nil
}

// CompareSheetStructure compares authored requirements, not pixels. Callers use
// one transaction so resolution cannot race a structural mutation.
func CompareSheetStructure(r Reader, workspace, id string) (*SheetComparison, error) {
	sheet, err := GetSheet(r, id)
	if err != nil {
		return nil, err
	}
	if sheet == nil || sheet.WorkspaceID != workspace {
		return nil, sql.ErrNoRows
	}
	c := &SheetComparison{SheetID: id, WorkspaceID: workspace, Name: sheet.Name, Revision: sheet.Revision, ResolvedAt: sheet.ResolvedAt, Differences: []SheetDifference{}, Nodes: []StructureNode{}, Mappings: map[string]string{}}
	add := func(kind, id, name, expected, actual, detail string) {
		c.Differences = append(c.Differences, SheetDifference{kind, id, name, expected, actual, detail})
	}
	live, _, err := loadLiveStructure(r, workspace)
	if err != nil {
		return nil, err
	}
	elements, err := GetSheetElements(r, id)
	if err != nil {
		return nil, err
	}
	plans, err := GetPlannedNodes(r, id)
	if err != nil {
		return nil, err
	}
	layouts, err := GetSheetLayouts(r, id)
	if err != nil {
		return nil, err
	}
	bindings := map[string]string{}
	rows, err := r.Query(`SELECT planned_id,live_id FROM sheet_bindings WHERE sheet_id=?`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p, l string
		if err = rows.Scan(&p, &l); err != nil {
			rows.Close()
			return nil, err
		}
		bindings[p] = l
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// Removal wins over a move: a node the sheet takes away has no place to be
	// checked, only an absence to be checked for.
	removals, err := GetSheetRemovals(r, workspace, id)
	if err != nil {
		return nil, err
	}
	removed := map[string]bool{}
	for _, removal := range removals {
		removed[removal.NodeID] = true
	}
	desired := map[string]StructureNode{}
	for _, e := range elements {
		if removed[refValue(e.FileID)] || removed[refValue(e.SystemID)] || removed[refValue(e.InfraID)] {
			continue
		}
		n := StructureNode{ID: refValue(e.FileID), Type: "file", Name: e.Label, ParentID: refValue(e.ParentSystemID)}
		if e.SystemID != nil {
			n.ID = *e.SystemID
			n.Type = "system"
		}
		if e.InfraID != nil {
			n.ID = *e.InfraID
			n.Type = "infra"
		}
		if n.ID == "" {
			add("unverifiable", e.ID, e.Label, "", "", "Deleted or symbol-only reference must be removed or replaced before resolution")
			continue
		}
		n.Containment = containment(n.ParentID, live[n.ParentID].Type)
		desired[n.ID] = n
		c.Mappings[n.ID] = n.ID
	}
	rejected := map[string]bool{}
	for _, p := range plans {
		if p.ApprovalStatus == "rejected" {
			rejected[p.ID] = true
			continue
		}
		pid := "planned:" + p.ID
		if p.ApprovalStatus != "approved" {
			add("approval", pid, p.Name, "approved", p.ApprovalStatus, "Proposal still needs user approval")
		}
		liveID := bindings[p.ID]
		if plannedType(p.Kind) == "file" && liveID != "" && liveID != refValue(p.RealizedFileID) {
			add("implementation", pid, p.Name, refValue(p.RealizedFileID), liveID, "Binding no longer matches indexed file realization; refresh the binding")
			liveID = ""
		}
		if liveID == "" && p.RealizedFileID != nil && plannedType(p.Kind) == "file" {
			liveID = *p.RealizedFileID
		}
		if liveID != "" && live[liveID].Type == plannedType(p.Kind) {
			c.Mappings[pid] = liveID
		} else {
			add("create", pid, p.Name, plannedType(p.Kind), "", "Implement this element, then bind it to a live node; file contracts also require indexed realization")
		}
		if plannedType(p.Kind) == "file" && p.Status != "realized" && p.Status != "flattened" {
			add("implementation", pid, p.Name, "realized", p.Status, "Indexed file and contract evidence has not yet matched the planned element")
		}
		desired[pid] = StructureNode{pid, plannedType(p.Kind), p.Name, refValue(p.ParentSystemID), containment(refValue(p.ParentSystemID), live[refValue(p.ParentSystemID)].Type)}
	}
	// Canonical layout opinions also include nodes inherited from the Floor that
	// are not duplicated in sheet_elements. They are still authored requirements.
	for _, l := range layouts {
		if removed[l.NodeID] {
			continue
		}
		n, ok := desired[l.NodeID]
		if !ok {
			if strings.HasPrefix(l.NodeID, "planned:") {
				continue
			}
			n = live[l.NodeID]
			n.ID = l.NodeID
			n.Type = l.NodeType
			if n.Name == "" {
				n.Name = l.NodeID
			}
			c.Mappings[n.ID] = n.ID
		}
		n.ParentID = refValue(l.ParentNodeID)
		n.Containment = l.ContainmentKind
		desired[n.ID] = n
	}
	for _, n := range desired {
		c.Checked++
		c.Nodes = append(c.Nodes, n)
		actual, ok := live[c.Mappings[n.ID]]
		if !ok {
			if !strings.HasPrefix(n.ID, "planned:") {
				add("missing", n.ID, n.Name, n.Type, "", "Referenced live element no longer exists")
			}
			continue
		}
		parent := n.ParentID
		if strings.HasPrefix(parent, "planned:") {
			parent = c.Mappings[parent]
			if parent == "" {
				add("parent", n.ID, n.Name, n.ParentID, actual.ParentID, "Implement and bind the proposed parent first")
				continue
			}
		}
		if parent != "" {
			if _, ok := live[parent]; !ok {
				add("parent", n.ID, n.Name, parent, actual.ParentID, "Required parent no longer exists")
				continue
			}
		}
		if actual.ParentID != parent || actual.Containment != n.Containment {
			add("nesting", n.ID, n.Name, parent, actual.ParentID, "Match parent and containment: "+n.Containment+" (live: "+actual.Containment+")")
		}
	}
	for _, removal := range removals {
		c.Checked++
		c.Removals = append(c.Removals, removal.NodeID)
		if !removal.Done {
			add("removal", removal.NodeID, removal.Label, "removed", removal.NodeType, removalDetail(removal.NodeType))
		}
	}
	edges, err := GetPlannedEdges(r, id)
	if err != nil {
		return nil, err
	}
	deps, err := GetDependencies(r, workspace)
	if err != nil {
		return nil, err
	}
	for _, e := range edges {
		if rejected[refValue(e.SrcPlanned)] || rejected[refValue(e.DstPlanned)] {
			continue
		}
		src, dst := refValue(e.SrcLive), refValue(e.DstLive)
		if e.SrcPlanned != nil {
			src = c.Mappings["planned:"+*e.SrcPlanned]
		}
		if e.DstPlanned != nil {
			dst = c.Mappings["planned:"+*e.DstPlanned]
		}
		c.Checked++
		found := src != "" && dst != "" && live[src].ID != "" && live[dst].ID != "" && relationshipPresent(e.Kind, src, dst, deps, live)
		if !found {
			add("relationship", e.ID, e.Kind, src+" → "+dst, "", "Required typed relationship is not present in the live model")
		}
	}
	if c.Checked == 0 {
		add("unverifiable", id, sheet.Name, "", "", "This sheet has no structural requirements to verify")
	}
	sort.Slice(c.Nodes, func(i, j int) bool { return c.Nodes[i].ID < c.Nodes[j].ID })
	sort.Slice(c.Differences, func(i, j int) bool {
		a, b := c.Differences[i], c.Differences[j]
		return a.NodeID+a.Kind < b.NodeID+b.Kind
	})
	c.Equivalent = len(c.Differences) == 0
	encoded, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(encoded)
	c.Token = hex.EncodeToString(hash[:])
	return c, nil
}

func BindSheetNode(d *sql.DB, workspace, sheetID, plannedID, liveID string, revision int) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	sheet, err := GetSheet(tx, sheetID)
	if err != nil {
		return err
	}
	if sheet == nil || sheet.WorkspaceID != workspace {
		return sql.ErrNoRows
	}
	if sheet.Revision != revision || sheet.ResolvedAt != nil {
		return ErrInboxConflict
	}
	var kind string
	if err = tx.QueryRow(`SELECT kind FROM planned_nodes WHERE id=? AND sheet_id=? AND workspace_id=? AND approval_status='approved'`, strings.TrimPrefix(plannedID, "planned:"), sheetID, workspace).Scan(&kind); err != nil {
		return err
	}
	if plannedType(kind) == "file" {
		var realized sql.NullString
		if err = tx.QueryRow(`SELECT realized_file_id FROM planned_nodes WHERE id=?`, strings.TrimPrefix(plannedID, "planned:")).Scan(&realized); err != nil {
			return err
		}
		if !realized.Valid || realized.String != liveID {
			return fmt.Errorf("file bindings must match independently indexed realization evidence")
		}
	}
	ok, err := nodeBelongsToWorkspace(tx, workspace, plannedType(kind), liveID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("live node must have the planned type and belong to this workspace")
	}
	_, err = tx.Exec(`INSERT INTO sheet_bindings(sheet_id,planned_id,live_id,node_type) VALUES(?,?,?,?) ON CONFLICT(sheet_id,planned_id) DO UPDATE SET live_id=excluded.live_id,node_type=excluded.node_type`, sheetID, strings.TrimPrefix(plannedID, "planned:"), liveID, plannedType(kind))
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE sheets SET revision=revision+1,updated_at=? WHERE id=?`, time.Now().UnixMilli(), sheetID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// ApplySheetNesting makes one explicit structural change, preserving live
// geometry. It cannot fabricate files, contracts, or dependency evidence.
func ApplySheetNesting(d *sql.DB, workspace, sheetID, nodeID string, revision int, token string) (*FloorLayoutBatchResult, error) {
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	c, err := CompareSheetStructure(tx, workspace, sheetID)
	if err != nil {
		return nil, err
	}
	if c.Revision != revision || c.Token != token || c.ResolvedAt != nil {
		return nil, ErrInboxConflict
	}
	var desired *StructureNode
	for i := range c.Nodes {
		if c.Nodes[i].ID == nodeID {
			desired = &c.Nodes[i]
			break
		}
	}
	if desired == nil {
		return nil, fmt.Errorf("node is not a requirement of this sheet")
	}
	for _, difference := range c.Differences {
		if (difference.NodeID == nodeID || difference.NodeID == desired.ParentID) && difference.Kind == "approval" {
			return nil, fmt.Errorf("node requires approval")
		}
	}
	id := c.Mappings[nodeID]
	if id == "" {
		return nil, fmt.Errorf("implement and bind the live node first")
	}
	parent := desired.ParentID
	if strings.HasPrefix(parent, "planned:") {
		parent = c.Mappings[parent]
		if parent == "" {
			return nil, fmt.Errorf("implement and bind the parent first")
		}
	}
	layouts, err := GetFloorLayouts(tx, workspace)
	if err != nil {
		return nil, err
	}
	layout := FloorLayout{WorkspaceID: workspace, NodeID: id, NodeType: desired.Type, Width: 220, Height: 110, Scale: 1, InteriorScale: 1}
	if desired.Type == "system" || desired.Type == "infra" {
		layout.Width = 620
		layout.Height = 420
	}
	for _, l := range layouts {
		if l.NodeID == id {
			layout = l
			break
		}
	}
	layout.ParentNodeID = nil
	layout.ParentNodeType = nil
	if parent != "" {
		parentType := "system"
		var exists bool
		if err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM infra_nodes WHERE id=? AND workspace_id=?)`, parent, workspace).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			parentType = "infra"
		}
		layout.ParentNodeID = &parent
		layout.ParentNodeType = &parentType
	}
	result, err := applyFloorLayoutBatch(tx, workspace, []FloorLayout{layout})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// relationshipPresent reports whether the live model has the relationship a
// sheet asks for. CONTAINS is nesting. DEPENDS_ON is any code dependency
// (an import or a call) from inside src to inside dst - systems count the
// files in and below them, because the code depends file to file. Any other
// kind must match a live dependency of that type between the two nodes.
func relationshipPresent(kind, src, dst string, deps []Dependency, live map[string]StructureNode) bool {
	if strings.EqualFold(kind, "CONTAINS") {
		return live[dst].ParentID == src
	}
	general := strings.EqualFold(kind, "DEPENDS_ON")
	for _, d := range deps {
		if d.Src == src && d.Dst == dst && strings.EqualFold(d.DependencyType, kind) {
			return true
		}
		if !general || d.Status == "dismissed" {
			continue
		}
		codeDependency := strings.EqualFold(d.DependencyType, "IMPORTS") || strings.EqualFold(d.DependencyType, "CALLS") ||
			strings.EqualFold(d.DependencyType, "DEPENDS_ON")
		if codeDependency && within(live, d.Src, src) && within(live, d.Dst, dst) && !within(live, d.Dst, src) {
			return true
		}
	}
	return false
}

// within reports whether node is root or sits anywhere inside it.
func within(live map[string]StructureNode, node, root string) bool {
	for hops := 0; node != "" && hops < 64; hops++ {
		if node == root {
			return true
		}
		node = live[node].ParentID
	}
	return false
}
