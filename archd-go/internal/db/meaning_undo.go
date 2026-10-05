package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Undo reverses meaning edits from their journal rows. The inverse is itself a
// recorded, attributed meaning edit that names the row it reverses, so a
// review can pair the two and show nothing, and history stays append-only.
//
// An undo only applies when the map still looks the way the edit left it.
// If anything has changed since - the file moved again, the system was
// renamed again, the destination is gone - it refuses with ErrMeaningConflict
// rather than overwrite newer work.

// ErrMeaningConflict marks an undo that would overwrite later work. The HTTP
// layer maps it to 409.
var ErrMeaningConflict = errors.New("changed since")

func conflictErr(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrMeaningConflict, fmt.Sprintf(format, args...))
}

type undoDetail struct {
	Meaning        bool     `json:"meaning"`
	Restored       bool     `json:"restored"`
	From           string   `json:"from"`
	To             string   `json:"to"`
	FromParentID   *string  `json:"fromParentId"`
	ToParentID     *string  `json:"toParentId"`
	FromSystemID   *string  `json:"fromSystemId"`
	ToSystemID     *string  `json:"toSystemId"`
	Name           string   `json:"name"`
	Source         string   `json:"source"`
	Description    *string  `json:"description"`
	Color          *string  `json:"color"`
	ParentID       *string  `json:"parentId"`
	MovedFileIDs   []string `json:"movedFileIds"`
	MovedSystemIDs []string `json:"movedSystemIds"`
}

type undoEvent struct {
	StructuralEvent
	detail undoDetail
}

// UndoMeaningEvents reverses the given meaning edits, newest first, in one
// transaction. Either all of them are undone or none is.
func UndoMeaningEvents(
	database *sql.DB, workspaceID string, actor MeaningActor, eventIDs []int64,
) (MeaningResult, error) {
	if len(eventIDs) == 0 {
		return MeaningResult{}, meaningErr("eventIds is required")
	}
	return withMeaningBatch(database, workspaceID, actor, func(b *meaningBatch) error {
		events, err := b.loadUndoEvents(eventIDs)
		if err != nil {
			return err
		}
		for _, ev := range events {
			b.undoing = ev.ID
			if err := b.undo(ev); err != nil {
				return err
			}
			b.result.Changes = append(b.result.Changes, MeaningChange{Op: "undo", SystemID: ev.SubjectID, Changed: true})
		}
		b.undoing = 0
		return nil
	})
}

func (b *meaningBatch) loadUndoEvents(eventIDs []int64) ([]undoEvent, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(eventIDs)), ",")
	args := []any{b.workspaceID}
	for _, id := range eventIDs {
		args = append(args, id)
	}
	rows, err := b.tx.Query(`
		SELECT id, kind, subject_id, subject_label, object_id, object_label, detail
		FROM structural_events WHERE workspace_id = ? AND id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []undoEvent{}
	for rows.Next() {
		var ev undoEvent
		if err := rows.Scan(&ev.ID, &ev.Kind, &ev.SubjectID, &ev.SubjectLabel,
			&ev.ObjectID, &ev.ObjectLabel, &ev.Detail); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(ev.Detail), &ev.detail)
		if !ev.detail.Meaning {
			return nil, meaningErr("event %d is not a meaning edit and cannot be undone here", ev.ID)
		}
		if ev.detail.Restored {
			return nil, meaningErr("event %d restored a system; it cannot be undone again", ev.ID)
		}
		events = append(events, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(events) != len(eventIDs) {
		return nil, meaningErr("some events are not in this project")
	}
	sort.Slice(events, func(i, j int) bool { return events[i].ID > events[j].ID })
	return events, nil
}

func (b *meaningBatch) undo(ev undoEvent) error {
	d := ev.detail
	switch ev.Kind {
	case EventFileAssigned:
		var current sql.NullString
		if err := b.tx.QueryRow(`SELECT system_id FROM files WHERE id = ?`, ev.SubjectID).Scan(&current); err != nil {
			if err == sql.ErrNoRows {
				return conflictErr("%s no longer exists", ev.SubjectLabel)
			}
			return err
		}
		if !sameID(nullableString(current), d.ToSystemID) {
			return conflictErr("%s has moved again since", ev.SubjectLabel)
		}
		if err := b.requireSystem(d.FromSystemID); err != nil {
			return err
		}
		_, err := b.assign([]string{ev.SubjectID}, stringOf(d.FromSystemID))
		return err

	case EventSystemRenamed:
		system, ok := b.systems[ev.SubjectID]
		if !ok {
			return conflictErr("%s no longer exists", d.To)
		}
		if system.Name != d.To {
			return conflictErr("%s has been renamed again since", d.To)
		}
		_, err := b.rename(ev.SubjectID, d.From)
		return err

	case EventSystemNested:
		system, ok := b.systems[ev.SubjectID]
		if !ok {
			return conflictErr("%s no longer exists", ev.SubjectLabel)
		}
		if !sameID(system.ParentID, d.ToParentID) {
			return conflictErr("%s has moved again since", system.Name)
		}
		if err := b.requireSystem(d.FromParentID); err != nil {
			return err
		}
		_, err := b.nest(ev.SubjectID, d.FromParentID)
		return err

	case EventSystemCreated:
		system, ok := b.systems[ev.SubjectID]
		if !ok {
			return conflictErr("%s no longer exists", ev.SubjectLabel)
		}
		var files int
		if err := b.tx.QueryRow(`SELECT COUNT(*) FROM files WHERE system_id = ?`, ev.SubjectID).Scan(&files); err != nil {
			return err
		}
		if files > 0 || b.hasChildren(ev.SubjectID) {
			return conflictErr("%s holds work added since it was created", system.Name)
		}
		if err := b.deleteSystem(ev.SubjectID); err != nil {
			return err
		}
		_, err := b.journal(StructuralEvent{
			Kind: EventSystemDeleted, SubjectID: ev.SubjectID, SubjectLabel: system.Name,
		}, map[string]any{})
		return err

	case EventSystemMerged, EventSystemUngrouped:
		return b.restore(ev)
	}
	return meaningErr("event %d (%s) cannot be undone", ev.ID, ev.Kind)
}

// restore brings back a system removed by a merge or an ungroup, with the
// files and systems that left it, provided they are all still where the edit
// put them.
func (b *meaningBatch) restore(ev undoEvent) error {
	d := ev.detail
	if _, exists := b.systems[ev.SubjectID]; exists {
		return conflictErr("a system with %s's identity exists again", ev.SubjectLabel)
	}
	var target *string
	if ev.ObjectID != "" {
		target = &ev.ObjectID
		if _, ok := b.systems[ev.ObjectID]; !ok {
			return conflictErr("%s no longer exists", ev.ObjectLabel)
		}
	}
	for _, fileID := range d.MovedFileIDs {
		var current sql.NullString
		if err := b.tx.QueryRow(`SELECT system_id FROM files WHERE id = ?`, fileID).Scan(&current); err != nil {
			if err == sql.ErrNoRows {
				continue // the file itself was deleted; nothing to put back
			}
			return err
		}
		if !sameID(nullableString(current), target) {
			return conflictErr("files that left %s have moved again since", ev.SubjectLabel)
		}
	}
	for _, systemID := range d.MovedSystemIDs {
		if child, ok := b.systems[systemID]; ok && !sameID(child.ParentID, target) {
			return conflictErr("%s has moved again since", child.Name)
		}
	}

	parentID := d.ParentID
	if parentID != nil {
		if _, ok := b.systems[*parentID]; !ok {
			parentID = nil
		}
	}
	source := d.Source
	if source == "" {
		source = b.actor.source()
	}
	system := &System{
		ID: ev.SubjectID, WorkspaceID: b.workspaceID, Name: d.Name, ParentID: parentID,
		Source: source, Description: d.Description, Color: d.Color,
		Depth: b.depthUnder(parentID), CreatedAt: b.base.TS, UpdatedAt: b.base.TS,
	}
	if system.Name == "" {
		system.Name = ev.SubjectLabel
	}
	if _, err := b.tx.Exec(`
		INSERT INTO systems (id, workspace_id, name, parent_id, source, color, description,
		                     depth, position_x, position_y, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`,
		system.ID, system.WorkspaceID, system.Name, system.ParentID, system.Source, system.Color,
		system.Description, system.Depth, system.CreatedAt, system.UpdatedAt); err != nil {
		return err
	}
	b.systems[system.ID] = system
	b.upserted[system.ID] = true
	restoredTo := system.ID
	for _, fileID := range d.MovedFileIDs {
		var exists int
		if err := b.tx.QueryRow(`SELECT COUNT(*) FROM files WHERE id = ?`, fileID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			continue
		}
		if err := b.moveFile(fileID, &restoredTo); err != nil {
			return err
		}
	}
	for _, systemID := range d.MovedSystemIDs {
		if child, ok := b.systems[systemID]; ok {
			if err := b.reparent(child, &restoredTo); err != nil {
				return err
			}
		}
	}
	_, err := b.journal(StructuralEvent{
		Kind: EventSystemCreated, SubjectID: system.ID, SubjectLabel: system.Name,
	}, map[string]any{
		"restored": true, "parentId": parentID, "parentName": b.nameOf(parentID),
		"movedFileIds": d.MovedFileIDs, "movedSystemIds": d.MovedSystemIDs,
	})
	return err
}

// requireSystem fails with a conflict when an edit would put something back
// into a system that no longer exists. A nil id (top level) always exists.
func (b *meaningBatch) requireSystem(id *string) error {
	if id == nil {
		return nil
	}
	if _, ok := b.systems[*id]; !ok {
		return conflictErr("the system it came from no longer exists")
	}
	return nil
}

func (b *meaningBatch) hasChildren(systemID string) bool {
	for _, system := range b.systems {
		if system.ParentID != nil && *system.ParentID == systemID {
			return true
		}
	}
	return false
}
