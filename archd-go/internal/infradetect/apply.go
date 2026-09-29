package infradetect

import (
	"database/sql"
	"encoding/json"

	"axiom.local/archd/internal/db"
)

// Changes is what Apply did, for broadcasting to open canvases.
type Changes struct {
	Upserted     []db.InfraNode
	Removed      []string // infra node ids
	Connected    []db.Dependency
	Disconnected []string // dependency ids
}

// detectedBy is what a node records about why detection proposed it.
type detectedBy struct {
	Evidence     []Evidence `json:"evidence"`
	DeclaredOnly bool       `json:"declaredOnly,omitempty"`
	// Instance tells apart several nodes of one service (one per Dockerfile).
	Instance string `json:"instance,omitempty"`
}

// nodeKey matches a stored node to a proposal: service, plus the instance
// detection recorded for it.
func nodeKey(n *db.InfraNode) string {
	var by detectedBy
	_ = json.Unmarshal(n.DetectedBy, &by)
	if by.Instance == "" {
		return n.Service
	}
	return n.Service + "#" + by.Instance
}

// Apply persists detection for one root and reconciles it with what is
// stored. Nodes are workspace-wide; only evidence from this root's files is
// withdrawn, so worktrees of one project never erase each other's findings:
//
//   - a service someone dismissed stays dismissed; detection never re-proposes it;
//   - a confirmed node keeps its decision, and relationships detected into it
//     are confirmed (an import is a fact once the node is accepted);
//   - everything else is a proposal until the person or the agent decides;
//   - parser-owned evidence that no longer holds is withdrawn, and a proposal
//     left without evidence is removed. Nothing an agent or person wrote is.
func Apply(sqlDB *sql.DB, workspaceID, rootID string, result Result) (Changes, error) {
	var changes Changes
	existing, err := db.GetInfraNodes(sqlDB, workspaceID)
	if err != nil {
		return changes, err
	}
	byKey := map[string]*db.InfraNode{}
	for i := range existing {
		n := &existing[i]
		if key := nodeKey(n); n.Service != "" && byKey[key] == nil {
			byKey[key] = n
		}
	}

	wantedNodes := map[string]bool{}
	wantedEdges := map[[4]string]bool{}
	wantedContents := map[[3]string]bool{}
	nodeForService := map[string]string{}

	for _, p := range result.Proposals {
		key := proposalKey(&p)
		node := byKey[key]
		if node != nil && node.Status == "dismissed" {
			wantedNodes[node.ID] = true
			continue
		}
		if node == nil {
			node = &db.InfraNode{WorkspaceID: workspaceID, Name: p.Name, Category: p.Category,
				Provider: p.Provider, Service: p.Service, Subtype: p.Subtype, Status: "proposed"}
		}
		evidence, _ := json.Marshal(detectedBy{Evidence: p.Evidence, DeclaredOnly: p.DeclaredOnly, Instance: p.Instance})
		node.DetectedBy = evidence
		node.Implementations = mergeImplementations(node.Implementations, p.Implementations)
		if err := db.UpsertInfraNode(sqlDB, node); err != nil {
			return changes, err
		}
		changes.Upserted = append(changes.Upserted, *node)
		wantedNodes[node.ID] = true
		if p.Instance == "" {
			nodeForService[p.Service] = node.ID
		}

		status := "proposed"
		if node.Status == "confirmed" {
			status = "confirmed"
		}
		for _, e := range p.Edges {
			evidence := e.Evidence
			dep := db.Dependency{WorkspaceID: workspaceID, Src: e.FileID, Dst: node.ID, SrcType: "file", DstType: "infra",
				DependencyType: e.Kind, TargetItem: e.Item, CreatedBy: "parser", Evidence: &evidence, Status: status}
			if err := db.UpsertDependency(sqlDB, dep); err != nil {
				return changes, err
			}
			wantedEdges[[4]string{e.FileID, node.ID, e.Kind, e.Item}] = true
			changes.Connected = append(changes.Connected, dep)
		}
		for _, c := range p.Contents {
			detail, _ := json.Marshal(c.Detail)
			evidence := c.Evidence
			item := db.InfraContent{WorkspaceID: workspaceID, InfraID: node.ID, Kind: c.Kind, Name: c.Name,
				Detail: detail, Evidence: &evidence, Source: "parser"}
			if err := db.UpsertInfraContent(sqlDB, &item); err != nil {
				return changes, err
			}
			wantedContents[[3]string{node.ID, c.Kind, c.Name}] = true
		}
	}

	wantedRequirements := map[string]bool{}
	for _, r := range result.Requirements {
		req := db.InfraRequirement{WorkspaceID: workspaceID, Kind: "env", Name: r.Name, Present: r.Present, Source: "parser"}
		if id, ok := nodeForService[r.Service]; ok {
			req.InfraID = &id
		}
		if r.Evidence != "" {
			evidence := r.Evidence
			req.Evidence = &evidence
		}
		if err := db.UpsertInfraRequirement(sqlDB, &req); err != nil {
			return changes, err
		}
		wantedRequirements[r.Name] = true
	}

	// Withdraw parser-owned evidence that no longer holds.
	rows, err := sqlDB.Query(`SELECT d.id, d.src, d.dst, d.dependency_type, d.target_item FROM dependencies d
		JOIN files f ON f.id = d.src
		WHERE d.workspace_id = ? AND f.root_id = ? AND d.dst_type = 'infra' AND d.created_by = 'parser'`,
		workspaceID, rootID)
	if err != nil {
		return changes, err
	}
	var stale []string
	for rows.Next() {
		var id, src, dst, kind, item string
		if err := rows.Scan(&id, &src, &dst, &kind, &item); err != nil {
			rows.Close()
			return changes, err
		}
		if !wantedEdges[[4]string{src, dst, kind, item}] {
			stale = append(stale, id)
		}
	}
	rows.Close()
	for _, id := range stale {
		if err := db.DeleteDependency(sqlDB, id); err != nil {
			return changes, err
		}
		changes.Disconnected = append(changes.Disconnected, id)
	}

	for _, n := range existing {
		if wantedNodes[n.ID] || n.Status != "proposed" || len(n.DetectedBy) == 0 {
			continue
		}
		// Another root may still be the reason for this proposal.
		var remaining int
		if err := sqlDB.QueryRow(`SELECT count(*) FROM dependencies WHERE dst = ?`, n.ID).Scan(&remaining); err != nil {
			return changes, err
		}
		if remaining > 0 {
			continue
		}
		if err := db.DeleteInfraNode(sqlDB, n.ID); err != nil {
			return changes, err
		}
		changes.Removed = append(changes.Removed, n.ID)
	}

	contents, err := db.GetInfraContents(sqlDB, workspaceID)
	if err != nil {
		return changes, err
	}
	for _, c := range contents {
		if c.Source == "parser" && wantedNodes[c.InfraID] && !wantedContents[[3]string{c.InfraID, c.Kind, c.Name}] {
			if err := db.DeleteInfraContent(sqlDB, c.ID); err != nil {
				return changes, err
			}
		}
	}
	requirements, err := db.GetInfraRequirements(sqlDB, workspaceID)
	if err != nil {
		return changes, err
	}
	for _, r := range requirements {
		if r.Source == "parser" && !wantedRequirements[r.Name] {
			if _, err := sqlDB.Exec(`DELETE FROM infra_requirements WHERE id = ?`, r.ID); err != nil {
				return changes, err
			}
		}
	}
	return changes, nil
}

// mergeImplementations replaces the parser's entries and keeps everyone else's.
func mergeImplementations(stored json.RawMessage, detected []Implementation) json.RawMessage {
	var kept []map[string]any
	if len(stored) > 0 {
		var existing []map[string]any
		if json.Unmarshal(stored, &existing) == nil {
			for _, impl := range existing {
				if impl["source"] != "parser" {
					kept = append(kept, impl)
				}
			}
		}
	}
	for _, impl := range detected {
		raw, _ := json.Marshal(impl)
		var entry map[string]any
		_ = json.Unmarshal(raw, &entry)
		kept = append(kept, entry)
	}
	if len(kept) == 0 {
		return nil
	}
	out, _ := json.Marshal(kept)
	return out
}
