package api

import (
	"database/sql"
	"encoding/json"
	"log"

	"ambio.local/archd/internal/activity"
	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/delta"
)

// Journal rows for code starting or stopping to use infrastructure
// (delta/infra.go turns them into Review Changes claims). Detection's first
// run for a root in this process is its baseline and is not journaled: those
// relationships were already in the code, and reporting them all as new would
// bury the first review.

// journalInfraLink records one relationship from code (a file or a system) to
// an infrastructure node. Anything else is not a code→infrastructure change.
func journalInfraLink(sqlDB *sql.DB, workspaceID, rootID string, dep db.Dependency, kind, actor, sessionID string) {
	if dep.DstType != "infra" || (dep.SrcType != "file" && dep.SrcType != "system") {
		return
	}
	detail := delta.InfraDetail{Relationship: dep.DependencyType, Item: dep.TargetItem}
	srcLabel := dep.Src
	if dep.SrcType == "file" {
		var systemID sql.NullString
		if err := sqlDB.QueryRow(`SELECT rel_path, system_id FROM files WHERE id = ?`, dep.Src).Scan(&srcLabel, &systemID); err != nil {
			return
		}
		if systemID.Valid {
			detail.SrcSystem = systemID.String
			_ = sqlDB.QueryRow(`SELECT name FROM systems WHERE id = ?`, systemID.String).Scan(&detail.SrcSystemName)
		}
	} else {
		if err := sqlDB.QueryRow(`SELECT name FROM systems WHERE id = ?`, dep.Src).Scan(&srcLabel); err != nil {
			return
		}
		detail.SrcSystem, detail.SrcSystemName = dep.Src, srcLabel
	}
	infraName := dep.Dst
	_ = sqlDB.QueryRow(`SELECT name FROM infra_nodes WHERE id = ?`, dep.Dst).Scan(&infraName)
	encoded, _ := json.Marshal(detail)
	if err := db.RecordStructuralEvent(sqlDB, db.StructuralEvent{
		WorkspaceID: workspaceID, RootID: rootID, Actor: actor, Kind: kind,
		SubjectID: dep.Src, SubjectLabel: srcLabel, ObjectID: dep.Dst, ObjectLabel: infraName,
		Detail: string(encoded), SessionID: sessionID,
	}); err != nil {
		log.Printf("[infra] journal %s: %v", kind, err)
	}
}

// journalDetectedLinks records what a detection run found new or gone, after
// the root's baseline run.
func (s *Server) journalDetectedLinks(sqlDB *sql.DB, root db.Root, linked, unlinked []db.Dependency) {
	s.detectMu.Lock()
	first := !s.infraBaselined[root.ID]
	s.infraBaselined[root.ID] = true
	s.detectMu.Unlock()
	if first {
		return
	}
	actor := activity.ActorFor(root.WorkspaceID)
	for _, group := range []struct {
		kind string
		deps []db.Dependency
	}{{db.EventInfraLinked, linked}, {db.EventInfraUnlinked, unlinked}} {
		for _, dep := range group.deps {
			session := db.ActiveWorkSessionIDForRootEntities(sqlDB, root.WorkspaceID, root.ID, dep.Src)
			journalInfraLink(sqlDB, root.WorkspaceID, root.ID, dep, group.kind, actor, session)
		}
	}
}

// infraEdgeActor is who drew a relationship by hand: the agent, or a person.
func infraEdgeActor(createdBy string) string {
	if createdBy == "agent" {
		return "agent"
	}
	return "human"
}
