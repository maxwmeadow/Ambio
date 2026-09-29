package db

import (
	"database/sql"
	"encoding/json"

	"github.com/google/uuid"
)

// ContentKinds is what an infra node can contain (INFRA_LAYER_PLAN.md
// "Model"): the things code depends on inside a database, queue, cache, ....
var ContentKinds = map[string]bool{
	"table": true, "collection": true, "topic": true, "key_pattern": true,
	"bucket": true, "index": true, "method": true, "webhook": true,
	"model": true, "prompt": true, "flag": true, "schedule": true,
	"channel": true, "route": true, "event": true,
}

// InfraContent is one item of an infra node's contract.
type InfraContent struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	InfraID     string          `json:"infraId"`
	Kind        string          `json:"kind"`
	Name        string          `json:"name"`
	Detail      json.RawMessage `json:"detail,omitempty"`
	Evidence    *string         `json:"evidence,omitempty"`
	Source      string          `json:"source"`
}

// UpsertInfraContent records one contents item. A parser re-detecting an item
// never overwrites what an agent or person wrote about it.
func UpsertInfraContent(db *sql.DB, c *InfraContent) error {
	if c.ID == "" {
		c.ID = uuid.New().String()
	}
	if c.Source == "" {
		c.Source = "agent"
	}
	_, err := db.Exec(`
		INSERT INTO infra_contents (id, workspace_id, infra_id, kind, name, detail, evidence, source)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(infra_id, kind, name) DO UPDATE SET
			detail = CASE WHEN excluded.source = 'parser' AND source <> 'parser' THEN detail
				ELSE COALESCE(excluded.detail, detail) END,
			evidence = COALESCE(excluded.evidence, evidence),
			source = CASE WHEN excluded.source = 'parser' THEN source ELSE excluded.source END`,
		c.ID, c.WorkspaceID, c.InfraID, c.Kind, c.Name, nullableJSON(c.Detail), c.Evidence, c.Source)
	return err
}

func GetInfraContents(db Reader, workspaceID string) ([]InfraContent, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, infra_id, kind, name, detail, evidence, source
		FROM infra_contents WHERE workspace_id=? ORDER BY infra_id, kind, name`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InfraContent{}
	for rows.Next() {
		var c InfraContent
		var detail sql.NullString
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.InfraID, &c.Kind, &c.Name, &detail, &c.Evidence, &c.Source); err != nil {
			return nil, err
		}
		if detail.Valid {
			c.Detail = json.RawMessage(detail.String)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func DeleteInfraContent(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM infra_contents WHERE id=?`, id)
	return err
}

// InfraRequirement is something running this code needs. Only names are
// stored: an environment variable's value never enters the database.
type InfraRequirement struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspaceId"`
	Kind        string  `json:"kind"`
	Name        string  `json:"name"`
	InfraID     *string `json:"infraId,omitempty"`
	Evidence    *string `json:"evidence,omitempty"`
	Present     bool    `json:"present"`
	Source      string  `json:"source"`
}

// UpsertInfraRequirement records a requirement. A requirement already tied to
// an infra node keeps that tie unless the new row names one.
func UpsertInfraRequirement(db *sql.DB, r *InfraRequirement) error {
	if r.ID == "" {
		r.ID = uuid.New().String()
	}
	if r.Kind == "" {
		r.Kind = "env"
	}
	if r.Source == "" {
		r.Source = "parser"
	}
	_, err := db.Exec(`
		INSERT INTO infra_requirements (id, workspace_id, kind, name, infra_id, evidence, present, source)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(workspace_id, kind, name) DO UPDATE SET
			infra_id = COALESCE(excluded.infra_id, infra_id),
			evidence = COALESCE(excluded.evidence, evidence),
			present = excluded.present`,
		r.ID, r.WorkspaceID, r.Kind, r.Name, r.InfraID, r.Evidence, r.Present, r.Source)
	return err
}

func GetInfraRequirements(db Reader, workspaceID string) ([]InfraRequirement, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, kind, name, infra_id, evidence, present, source
		FROM infra_requirements WHERE workspace_id=? ORDER BY kind, name`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InfraRequirement{}
	for rows.Next() {
		var r InfraRequirement
		if err := rows.Scan(&r.ID, &r.WorkspaceID, &r.Kind, &r.Name, &r.InfraID, &r.Evidence, &r.Present, &r.Source); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetDependencyStatus decides a proposed edge.
func SetDependencyStatus(db *sql.DB, id, status string) error {
	_, err := db.Exec(`UPDATE dependencies SET status=? WHERE id=?`, status, id)
	return err
}

// HostingEvidence marks DEPLOYS_TO relationships that exist because a system
// sits inside a platform on the canvas, so moving it out removes exactly those.
const HostingEvidence = "canvas:hosted"

// ReconcileHostingEdges makes "hosted by this platform on the canvas" and
// "DEPLOYS_TO this platform" one fact: every system laid out inside a platform
// infra node deploys to it. Relationships an agent or person recorded are never
// touched; only canvas-derived ones are added and withdrawn.
func ReconcileHostingEdges(db *sql.DB, workspaceID string) (added []Dependency, removed []string, err error) {
	rows, err := db.Query(`
		SELECT l.node_id, l.parent_node_id FROM floor_layouts l
		JOIN infra_nodes i ON i.id = l.parent_node_id
		WHERE l.workspace_id = ? AND l.node_type = 'system' AND l.parent_node_type = 'infra' AND i.category = 'platform'`,
		workspaceID)
	if err != nil {
		return nil, nil, err
	}
	hosted := map[[2]string]bool{}
	for rows.Next() {
		var system, platform string
		if err := rows.Scan(&system, &platform); err != nil {
			rows.Close()
			return nil, nil, err
		}
		hosted[[2]string{system, platform}] = true
	}
	rows.Close()

	rows, err = db.Query(`
		SELECT id, src, dst FROM dependencies
		WHERE workspace_id = ? AND src_type = 'system' AND dst_type = 'infra'
		  AND dependency_type = 'DEPLOYS_TO' AND evidence = ?`, workspaceID, HostingEvidence)
	if err != nil {
		return nil, nil, err
	}
	existing := map[[2]string]string{}
	for rows.Next() {
		var id, system, platform string
		if err := rows.Scan(&id, &system, &platform); err != nil {
			rows.Close()
			return nil, nil, err
		}
		existing[[2]string{system, platform}] = id
	}
	rows.Close()

	evidence := HostingEvidence
	for pair := range hosted {
		if _, ok := existing[pair]; ok {
			continue
		}
		dep := Dependency{
			WorkspaceID: workspaceID, Src: pair[0], Dst: pair[1], SrcType: "system", DstType: "infra",
			DependencyType: "DEPLOYS_TO", CreatedBy: "user", Evidence: &evidence, Status: "confirmed",
		}
		if err := UpsertDependency(db, dep); err != nil {
			return nil, nil, err
		}
		added = append(added, dep)
	}
	for pair, id := range existing {
		if hosted[pair] {
			continue
		}
		if err := DeleteDependency(db, id); err != nil {
			return nil, nil, err
		}
		removed = append(removed, id)
	}
	return added, removed, nil
}

// PackageUse is one file loading one external package at a line.
type PackageUse struct {
	FileID  string
	RelPath string
	Package string
	Line    int
}

// EnvRead is one file reading one environment variable at a line.
type EnvRead struct {
	FileID  string
	RelPath string
	Name    string
	Line    int
}

// ReplaceFileEvidence swaps a file's detection evidence for a fresh parse.
func ReplaceFileEvidence(db *sql.DB, fileID string, packages []PackageUse, envReads []EnvRead) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if _, err := tx.Exec(`DELETE FROM file_packages WHERE file_id=?`, fileID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM file_env_reads WHERE file_id=?`, fileID); err != nil {
		return err
	}
	for _, p := range packages {
		if _, err := tx.Exec(`INSERT INTO file_packages (file_id, package, line) VALUES (?,?,?)`, fileID, p.Package, p.Line); err != nil {
			return err
		}
	}
	for _, e := range envReads {
		if _, err := tx.Exec(`INSERT INTO file_env_reads (file_id, name, line) VALUES (?,?,?)`, fileID, e.Name, e.Line); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetPackageUses lists every external package use in a root.
func GetPackageUses(db Reader, rootID string) ([]PackageUse, error) {
	rows, err := db.Query(`
		SELECT p.file_id, f.rel_path, p.package, p.line FROM file_packages p
		JOIN files f ON f.id = p.file_id WHERE f.root_id = ? ORDER BY f.rel_path, p.line`, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PackageUse
	for rows.Next() {
		var u PackageUse
		if err := rows.Scan(&u.FileID, &u.RelPath, &u.Package, &u.Line); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// GetEnvReads lists every environment variable read in a root.
func GetEnvReads(db Reader, rootID string) ([]EnvRead, error) {
	rows, err := db.Query(`
		SELECT e.file_id, f.rel_path, e.name, e.line FROM file_env_reads e
		JOIN files f ON f.id = e.file_id WHERE f.root_id = ? ORDER BY e.name, f.rel_path, e.line`, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EnvRead
	for rows.Next() {
		var r EnvRead
		if err := rows.Scan(&r.FileID, &r.RelPath, &r.Name, &r.Line); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DetectionEvidenceVersion reports which evidence version a root's index has.
func DetectionEvidenceVersion(db Reader, rootID string) int {
	var version int
	_ = db.QueryRow(`SELECT evidence_version FROM detection_state WHERE root_id=?`, rootID).Scan(&version)
	return version
}

func SetDetectionEvidenceVersion(db *sql.DB, rootID string, version int) error {
	_, err := db.Exec(`INSERT INTO detection_state (root_id, evidence_version) VALUES (?,?)
		ON CONFLICT(root_id) DO UPDATE SET evidence_version=excluded.evidence_version`, rootID, version)
	return err
}

// DecideDetectedEdges applies a node decision to the relationships detection
// proposed into it. Relationships already decided are left alone.
func DecideDetectedEdges(db *sql.DB, infraID, status string) error {
	_, err := db.Exec(`UPDATE dependencies SET status=? WHERE dst=? AND dst_type='infra' AND status='proposed'`, status, infraID)
	return err
}
