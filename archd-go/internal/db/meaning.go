package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Meaning edits change what the architecture says without touching code:
// naming, grouping and nesting systems, and which system a file belongs to.
// Systems are Axiom's interpretation of the code, so a human or an agent may
// change them freely - but every change is atomic, attributed and journaled,
// which is what makes it reviewable and undoable (docs/PRODUCT.md §2).
//
// Position and size are presentation and never come through here; neither
// does anything that needs the code itself to change.

// Meaning edit operations.
const (
	MeaningCreate   = "create"   // a new system, optionally holding files
	MeaningRename   = "rename"   // a system's name
	MeaningDescribe = "describe" // a system's description (not journaled)
	MeaningNest     = "nest"     // a system under another, or at the top level
	MeaningAssign   = "assign"   // files into a system, or out of every system
	MeaningMerge    = "merge"    // one system's contents into another; it goes
	MeaningUngroup  = "ungroup"  // a system's contents up a level; it goes
)

// MeaningActor says who made an edit. It is always stated by the caller and
// never inferred: the renderer speaks for the human, the MCP server for a
// named agent.
type MeaningActor struct {
	Kind      string `json:"kind"` // "human" | "agent"
	Agent     string `json:"agent,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
}

// MeaningEdit is one requested change. Which fields matter depends on Op:
//
//	create   SystemID (optional, generated when empty), Name, ParentID, Description, FileIDs
//	rename   SystemID, Name
//	describe SystemID, Description
//	nest     SystemID, ParentID (nil or "" = top level)
//	assign   FileIDs, SystemID ("" = out of every system)
//	merge    SystemID (the one that goes), IntoSystemID
//	ungroup  SystemID
type MeaningEdit struct {
	Op           string   `json:"op"`
	SystemID     string   `json:"systemId,omitempty"`
	Name         string   `json:"name,omitempty"`
	Description  *string  `json:"description,omitempty"`
	ParentID     *string  `json:"parentId,omitempty"`
	FileIDs      []string `json:"fileIds,omitempty"`
	IntoSystemID string   `json:"intoSystemId,omitempty"`
}

// MeaningChange reports what one edit did. Changed is false for an edit that
// asked for what was already true; such edits write nothing.
type MeaningChange struct {
	Op       string  `json:"op"`
	SystemID string  `json:"systemId,omitempty"`
	Changed  bool    `json:"changed"`
	EventIDs []int64 `json:"eventIds,omitempty"`
}

// FileAssignmentChange is one file's new owner, for live broadcast.
type FileAssignmentChange struct {
	FileID   string  `json:"fileId"`
	SystemID *string `json:"systemId"`
}

// MeaningResult is everything a batch changed, in the order it happened.
type MeaningResult struct {
	Changes          []MeaningChange        `json:"changes"`
	UpsertedSystems  []System               `json:"upsertedSystems"`
	DeletedSystemIDs []string               `json:"deletedSystemIds"`
	Assignments      []FileAssignmentChange `json:"assignments"`
}

// ErrMeaningEdit marks a request that cannot be applied as asked (unknown
// system, a cycle, a missing name). The HTTP layer maps it to 400.
var ErrMeaningEdit = errors.New("meaning edit")

func meaningErr(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrMeaningEdit, fmt.Sprintf(format, args...))
}

func (a MeaningActor) validate() error {
	switch a.Kind {
	case "human":
		return nil
	case "agent":
		if strings.TrimSpace(a.Agent) == "" {
			return meaningErr("an agent edit must name the agent")
		}
		return nil
	default:
		return meaningErr("actor.kind must be human or agent")
	}
}

// source is the systems.source value for a boundary this actor authored or
// confirmed. Authored systems are protected from re-clustering.
func (a MeaningActor) source() string {
	if a.Kind == "agent" {
		return "agent"
	}
	return "user"
}

// meaningBatch holds one batch's view of the workspace while it applies.
type meaningBatch struct {
	tx          *sql.Tx
	workspaceID string
	actor       MeaningActor
	base        StructuralEvent
	systems     map[string]*System
	result      *MeaningResult
	upserted    map[string]bool
	// undoing is the journal row an inverse edit reverses, recorded on the
	// new row so a review can pair the two.
	undoing int64
}

// ApplyMeaningEdits applies a batch of meaning edits in one transaction and
// journals each change. Either every edit applies or none does.
func ApplyMeaningEdits(
	database *sql.DB, workspaceID string, actor MeaningActor, edits []MeaningEdit,
) (MeaningResult, error) {
	return withMeaningBatch(database, workspaceID, actor, func(b *meaningBatch) error {
		for i, edit := range edits {
			change, err := b.apply(edit)
			if err != nil {
				return fmt.Errorf("edit %d (%s): %w", i+1, edit.Op, err)
			}
			b.result.Changes = append(b.result.Changes, change)
		}
		return nil
	})
}

func withMeaningBatch(
	database *sql.DB, workspaceID string, actor MeaningActor, run func(*meaningBatch) error,
) (MeaningResult, error) {
	result := MeaningResult{
		Changes: []MeaningChange{}, UpsertedSystems: []System{},
		DeletedSystemIDs: []string{}, Assignments: []FileAssignmentChange{},
	}
	if err := actor.validate(); err != nil {
		return result, err
	}
	if workspaceID == "" {
		return result, meaningErr("workspaceId is required")
	}

	// History identity: an agent's declared session says which worktree and
	// branch the edit belongs to; otherwise the primary root's.
	base := StructuralEvent{
		WorkspaceID: workspaceID, TS: time.Now().UnixMilli(), Actor: actor.Kind,
	}
	if actor.SessionID != "" {
		if session, err := GetWorkSession(database, workspaceID, actor.SessionID); err == nil {
			base.SessionID = session.ID
			base.RootID, base.Branch = session.RootID, session.Branch
		}
	}
	base.RootID, base.Branch = completeHistoryIdentity(database, workspaceID, base.RootID, base.Branch)

	tx, err := database.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()

	systems, err := GetSystems(tx, workspaceID)
	if err != nil {
		return result, err
	}
	batch := &meaningBatch{
		tx: tx, workspaceID: workspaceID, actor: actor, base: base,
		systems: make(map[string]*System, len(systems)), result: &result,
		upserted: map[string]bool{},
	}
	for i := range systems {
		batch.systems[systems[i].ID] = &systems[i]
	}
	if err := run(batch); err != nil {
		return MeaningResult{}, err
	}
	for id := range batch.upserted {
		if system, ok := batch.systems[id]; ok {
			result.UpsertedSystems = append(result.UpsertedSystems, *system)
		}
	}
	if err := tx.Commit(); err != nil {
		return MeaningResult{}, err
	}
	return result, nil
}

func (b *meaningBatch) apply(edit MeaningEdit) (MeaningChange, error) {
	change := MeaningChange{Op: edit.Op, SystemID: edit.SystemID}
	var err error
	switch edit.Op {
	case MeaningCreate:
		change.SystemID, change.EventIDs, err = b.create(edit)
	case MeaningRename:
		change.EventIDs, err = b.rename(edit.SystemID, edit.Name)
	case MeaningDescribe:
		err = b.describe(edit.SystemID, edit.Description)
		change.Changed = err == nil
		return change, err
	case MeaningNest:
		change.EventIDs, err = b.nest(edit.SystemID, optionalID(edit.ParentID))
	case MeaningAssign:
		change.EventIDs, err = b.assign(edit.FileIDs, edit.SystemID)
	case MeaningMerge:
		change.EventIDs, err = b.merge(edit.SystemID, edit.IntoSystemID)
	case MeaningUngroup:
		change.EventIDs, err = b.ungroup(edit.SystemID)
	default:
		err = meaningErr("unknown op %q", edit.Op)
	}
	change.Changed = len(change.EventIDs) > 0
	return change, err
}

// ─── Operations ───────────────────────────────────────────────────────────────

func (b *meaningBatch) create(edit MeaningEdit) (string, []int64, error) {
	name := strings.TrimSpace(edit.Name)
	if name == "" {
		return "", nil, meaningErr("a new system needs a name")
	}
	id := edit.SystemID
	if id == "" {
		id = uuid.New().String()
	}
	if _, exists := b.systems[id]; exists {
		return "", nil, meaningErr("system %s already exists", id)
	}
	parentID := optionalID(edit.ParentID)
	depth := 0
	if parentID != nil {
		parent, err := b.system(*parentID)
		if err != nil {
			return "", nil, err
		}
		depth = parent.Depth + 1
	}
	now := b.base.TS
	system := &System{
		ID: id, WorkspaceID: b.workspaceID, Name: name, ParentID: parentID,
		Source: b.actor.source(), Description: edit.Description, Depth: depth,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, err := b.tx.Exec(`
		INSERT INTO systems (id, workspace_id, name, parent_id, source, description,
		                     depth, position_x, position_y, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
		system.ID, system.WorkspaceID, system.Name, system.ParentID, system.Source,
		system.Description, system.Depth, now, now); err != nil {
		return "", nil, err
	}
	b.systems[id] = system
	b.upserted[id] = true
	if parentID != nil {
		if err := b.adopt(*parentID); err != nil {
			return "", nil, err
		}
	}
	eventID, err := b.journal(StructuralEvent{
		Kind: EventSystemCreated, SubjectID: id, SubjectLabel: name,
	}, map[string]any{"parentId": parentID, "parentName": b.nameOf(parentID)})
	if err != nil {
		return "", nil, err
	}
	events := []int64{eventID}
	if len(edit.FileIDs) > 0 {
		assigned, err := b.assign(edit.FileIDs, id)
		if err != nil {
			return "", nil, err
		}
		events = append(events, assigned...)
	}
	return id, events, nil
}

func (b *meaningBatch) rename(systemID, name string) ([]int64, error) {
	system, err := b.system(systemID)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, meaningErr("a system name cannot be empty")
	}
	if name == system.Name {
		return nil, nil
	}
	from := system.Name
	system.Name = name
	if err := b.writeSystem(system); err != nil {
		return nil, err
	}
	// A renamed cluster is a boundary someone has now spoken for.
	if err := b.adopt(systemID); err != nil {
		return nil, err
	}
	eventID, err := b.journal(StructuralEvent{
		Kind: EventSystemRenamed, SubjectID: systemID, SubjectLabel: name,
	}, map[string]any{"from": from, "to": name})
	if err != nil {
		return nil, err
	}
	return []int64{eventID}, nil
}

func (b *meaningBatch) describe(systemID string, description *string) error {
	system, err := b.system(systemID)
	if err != nil {
		return err
	}
	if description != nil && strings.TrimSpace(*description) == "" {
		description = nil
	}
	system.Description = description
	return b.writeSystem(system)
}

func (b *meaningBatch) nest(systemID string, parentID *string) ([]int64, error) {
	system, err := b.system(systemID)
	if err != nil {
		return nil, err
	}
	if sameID(system.ParentID, parentID) {
		return nil, nil
	}
	if parentID != nil {
		if _, err := b.system(*parentID); err != nil {
			return nil, err
		}
		if b.isWithin(*parentID, systemID) {
			return nil, meaningErr("cannot nest a system inside itself or one of its own systems")
		}
	}
	from := system.ParentID
	if err := b.reparent(system, parentID); err != nil {
		return nil, err
	}
	if err := b.adopt(systemID); err != nil {
		return nil, err
	}
	if parentID != nil {
		if err := b.adopt(*parentID); err != nil {
			return nil, err
		}
	}
	eventID, err := b.journal(StructuralEvent{
		Kind: EventSystemNested, SubjectID: systemID, SubjectLabel: system.Name,
		ObjectID: stringOf(parentID), ObjectLabel: b.nameOf(parentID),
	}, map[string]any{
		"fromParentId": from, "fromParentName": b.nameOf(from),
		"toParentId": parentID, "toParentName": b.nameOf(parentID),
	})
	if err != nil {
		return nil, err
	}
	return []int64{eventID}, nil
}

func (b *meaningBatch) assign(fileIDs []string, systemID string) ([]int64, error) {
	if len(fileIDs) == 0 {
		return nil, meaningErr("assign needs fileIds")
	}
	var target *string
	if systemID != "" {
		if _, err := b.system(systemID); err != nil {
			return nil, err
		}
		target = &systemID
	}
	events := []int64{}
	seen := map[string]bool{}
	for _, fileID := range fileIDs {
		if seen[fileID] {
			continue
		}
		seen[fileID] = true
		var relPath string
		var current sql.NullString
		err := b.tx.QueryRow(`
			SELECT f.rel_path, f.system_id FROM files f JOIN roots r ON r.id = f.root_id
			WHERE f.id = ? AND r.workspace_id = ?`, fileID, b.workspaceID).Scan(&relPath, &current)
		if err == sql.ErrNoRows {
			return nil, meaningErr("file %s is not in this project", fileID)
		}
		if err != nil {
			return nil, err
		}
		from := nullableString(current)
		if sameID(from, target) {
			continue
		}
		if err := b.moveFile(fileID, target); err != nil {
			return nil, err
		}
		eventID, err := b.journal(StructuralEvent{
			Kind: EventFileAssigned, SubjectID: fileID, SubjectLabel: relPath,
			ObjectID: systemID, ObjectLabel: b.nameOf(target),
		}, map[string]any{
			"fromSystemId": from, "fromSystemName": b.nameOf(from),
			"toSystemId": target, "toSystemName": b.nameOf(target),
		})
		if err != nil {
			return nil, err
		}
		events = append(events, eventID)
	}
	if target != nil && len(events) > 0 {
		if err := b.adopt(systemID); err != nil {
			return nil, err
		}
	}
	return events, nil
}

func (b *meaningBatch) merge(sourceID, intoID string) ([]int64, error) {
	source, err := b.system(sourceID)
	if err != nil {
		return nil, err
	}
	if _, err := b.system(intoID); err != nil {
		return nil, err
	}
	if sourceID == intoID {
		return nil, meaningErr("cannot merge a system into itself")
	}
	if b.isWithin(intoID, sourceID) {
		return nil, meaningErr("cannot merge a system into one of its own systems")
	}
	snapshot := b.describeForUndo(source)
	movedFiles, movedSystems, err := b.emptyInto(source, &intoID)
	if err != nil {
		return nil, err
	}
	if err := b.deleteSystem(sourceID); err != nil {
		return nil, err
	}
	if err := b.adopt(intoID); err != nil {
		return nil, err
	}
	snapshot["movedFileIds"] = movedFiles
	snapshot["movedSystemIds"] = movedSystems
	eventID, err := b.journal(StructuralEvent{
		Kind: EventSystemMerged, SubjectID: sourceID, SubjectLabel: source.Name,
		ObjectID: intoID, ObjectLabel: b.nameOf(&intoID),
	}, snapshot)
	if err != nil {
		return nil, err
	}
	return []int64{eventID}, nil
}

func (b *meaningBatch) ungroup(systemID string) ([]int64, error) {
	system, err := b.system(systemID)
	if err != nil {
		return nil, err
	}
	parentID := system.ParentID
	snapshot := b.describeForUndo(system)
	movedFiles, movedSystems, err := b.emptyInto(system, parentID)
	if err != nil {
		return nil, err
	}
	if err := b.deleteSystem(systemID); err != nil {
		return nil, err
	}
	if parentID != nil {
		if err := b.adopt(*parentID); err != nil {
			return nil, err
		}
	}
	snapshot["movedFileIds"] = movedFiles
	snapshot["movedSystemIds"] = movedSystems
	eventID, err := b.journal(StructuralEvent{
		Kind: EventSystemUngrouped, SubjectID: systemID, SubjectLabel: system.Name,
		ObjectID: stringOf(parentID), ObjectLabel: b.nameOf(parentID),
	}, snapshot)
	if err != nil {
		return nil, err
	}
	return []int64{eventID}, nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func (b *meaningBatch) system(id string) (*System, error) {
	if id == "" {
		return nil, meaningErr("systemId is required")
	}
	system, ok := b.systems[id]
	if !ok {
		return nil, meaningErr("system %s is not in this project", id)
	}
	return system, nil
}

func (b *meaningBatch) nameOf(id *string) string {
	if id == nil {
		return ""
	}
	if system, ok := b.systems[*id]; ok {
		return system.Name
	}
	return ""
}

// isWithin reports whether candidate is ancestor itself or nested under it.
func (b *meaningBatch) isWithin(candidate, ancestor string) bool {
	seen := map[string]bool{}
	for id := &candidate; id != nil; {
		if *id == ancestor {
			return true
		}
		if seen[*id] {
			return false
		}
		seen[*id] = true
		system, ok := b.systems[*id]
		if !ok {
			return false
		}
		id = system.ParentID
	}
	return false
}

// adopt marks a system and its ancestors as authored by this actor, so the
// classifier can never prune or rewrite a boundary someone has spoken for.
// Systems another person or agent authored keep their source.
func (b *meaningBatch) adopt(systemID string) error {
	seen := map[string]bool{}
	for id := &systemID; id != nil; {
		if seen[*id] {
			return nil
		}
		seen[*id] = true
		system, ok := b.systems[*id]
		if !ok {
			return nil
		}
		if system.Source == "cluster" || system.Source == "directory" {
			system.Source = b.actor.source()
			if err := b.writeSystem(system); err != nil {
				return err
			}
		}
		id = system.ParentID
	}
	return nil
}

func (b *meaningBatch) writeSystem(system *System) error {
	system.UpdatedAt = b.base.TS
	if _, err := b.tx.Exec(`
		UPDATE systems SET name=?, parent_id=?, source=?, description=?, depth=?, updated_at=?
		WHERE id=? AND workspace_id=?`,
		system.Name, system.ParentID, system.Source, system.Description, system.Depth,
		system.UpdatedAt, system.ID, b.workspaceID); err != nil {
		return err
	}
	b.upserted[system.ID] = true
	return nil
}

// reparent moves a system under a new parent and keeps the depth of its whole
// subtree consistent. Its Floor geometry was measured against the old parent,
// so it is dropped and the renderer places it afresh.
func (b *meaningBatch) reparent(system *System, parentID *string) error {
	system.ParentID = parentID
	if err := b.setDepth(system, b.depthUnder(parentID)); err != nil {
		return err
	}
	_, err := b.tx.Exec(`
		DELETE FROM floor_layouts WHERE workspace_id=? AND node_type='system' AND node_id=?`,
		b.workspaceID, system.ID)
	return err
}

func (b *meaningBatch) depthUnder(parentID *string) int {
	if parentID == nil {
		return 0
	}
	if parent, ok := b.systems[*parentID]; ok {
		return parent.Depth + 1
	}
	return 0
}

func (b *meaningBatch) setDepth(system *System, depth int) error {
	system.Depth = depth
	if err := b.writeSystem(system); err != nil {
		return err
	}
	for _, child := range b.systems {
		if child.ParentID != nil && *child.ParentID == system.ID && child.ID != system.ID {
			if err := b.setDepth(child, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *meaningBatch) moveFile(fileID string, target *string) error {
	if _, err := b.tx.Exec(`UPDATE files SET system_id=? WHERE id=?`, target, fileID); err != nil {
		return err
	}
	// Geometry measured against the old system is meaningless in the new one.
	if _, err := b.tx.Exec(`
		DELETE FROM floor_layouts
		WHERE workspace_id=? AND node_type='file' AND node_id=?
		  AND containment_kind IN ('root','part_of')
		  AND COALESCE(
			CASE WHEN containment_kind='part_of' AND parent_node_type='system'
			     THEN parent_node_id ELSE '' END, ''
		  ) <> COALESCE(?, '')`,
		b.workspaceID, fileID, target); err != nil {
		return fmt.Errorf("reconcile layout for file %s: %w", fileID, err)
	}
	b.result.Assignments = append(b.result.Assignments, FileAssignmentChange{FileID: fileID, SystemID: target})
	return nil
}

// emptyInto moves a system's files and child systems to target (nil = out of
// every system / top level) and reports what moved, for undo.
func (b *meaningBatch) emptyInto(system *System, target *string) ([]string, []string, error) {
	rows, err := b.tx.Query(`
		SELECT f.id FROM files f JOIN roots r ON r.id = f.root_id
		WHERE f.system_id = ? AND r.workspace_id = ? ORDER BY f.rel_path`, system.ID, b.workspaceID)
	if err != nil {
		return nil, nil, err
	}
	files := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, err
		}
		files = append(files, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	for _, fileID := range files {
		if err := b.moveFile(fileID, target); err != nil {
			return nil, nil, err
		}
	}
	children := []string{}
	for _, child := range b.systems {
		if child.ParentID != nil && *child.ParentID == system.ID {
			children = append(children, child.ID)
		}
	}
	for _, childID := range children {
		if err := b.reparent(b.systems[childID], target); err != nil {
			return nil, nil, err
		}
	}
	return files, children, nil
}

func (b *meaningBatch) deleteSystem(systemID string) error {
	if _, err := b.tx.Exec(`DELETE FROM systems WHERE id=? AND workspace_id=?`, systemID, b.workspaceID); err != nil {
		return err
	}
	delete(b.systems, systemID)
	delete(b.upserted, systemID)
	b.result.DeletedSystemIDs = append(b.result.DeletedSystemIDs, systemID)
	return nil
}

// describeForUndo captures what is needed to bring a removed system back.
func (b *meaningBatch) describeForUndo(system *System) map[string]any {
	return map[string]any{
		"name": system.Name, "source": system.Source, "description": system.Description,
		"parentId": system.ParentID, "parentName": b.nameOf(system.ParentID),
		"color": system.Color,
	}
}

func (b *meaningBatch) journal(ev StructuralEvent, detail map[string]any) (int64, error) {
	detail["meaning"] = true
	if b.actor.Agent != "" {
		detail["agent"] = b.actor.Agent
	}
	if b.undoing != 0 {
		detail["undoes"] = []int64{b.undoing}
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return 0, err
	}
	ev.WorkspaceID = b.base.WorkspaceID
	ev.RootID, ev.Branch = b.base.RootID, b.base.Branch
	ev.TS = b.base.TS
	ev.Actor = b.base.Actor
	ev.SessionID = b.base.SessionID
	ev.Detail = string(encoded)
	return recordStructuralEventTx(b.tx, ev)
}

func optionalID(id *string) *string {
	if id == nil || *id == "" {
		return nil
	}
	return id
}

func sameID(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func stringOf(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

func nullableString(value sql.NullString) *string {
	if !value.Valid || value.String == "" {
		return nil
	}
	s := value.String
	return &s
}
