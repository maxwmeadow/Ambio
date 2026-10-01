package delta

import (
	"encoding/json"
	"fmt"
	"sort"

	"axiom.local/archd/internal/db"
)

// Meaning claims report changes to what the architecture says - a file moved
// between systems, a system renamed, nested, merged, ungrouped or newly
// grouped - made by a person or an agent (db/meaning.go). Each claim carries
// the journal rows that produced it, so it can be undone from the review.

const (
	ClaimMoved     ClaimKind = "meaning.moved"
	ClaimRenamed   ClaimKind = "meaning.renamed"
	ClaimNested    ClaimKind = "meaning.nested"
	ClaimMerged    ClaimKind = "meaning.merged"
	ClaimUngrouped ClaimKind = "meaning.ungrouped"
	ClaimGrouped   ClaimKind = "meaning.grouped"
)

func init() {
	for _, kind := range []ClaimKind{ClaimMoved, ClaimRenamed, ClaimNested, ClaimUngrouped, ClaimGrouped} {
		claimSeverity[kind] = 5
	}
	claimSeverity[ClaimMerged] = 6
}

// MeaningChange is one net change to meaning in the window.
type MeaningChange struct {
	Kind         string   `json:"kind"` // moved|renamed|nested|merged|ungrouped|grouped
	SubjectID    string   `json:"subjectId"`
	SubjectLabel string   `json:"subjectLabel"`
	FromID       string   `json:"fromId,omitempty"`
	FromLabel    string   `json:"fromLabel,omitempty"`
	ToID         string   `json:"toId,omitempty"`
	ToLabel      string   `json:"toLabel,omitempty"`
	FileIDs      []string `json:"fileIds,omitempty"`
	FileLabels   []string `json:"fileLabels,omitempty"`
	Actor        string   `json:"actor"`
	Agent        string   `json:"agent,omitempty"`
	SessionID    string   `json:"sessionId,omitempty"`
	TS           int64    `json:"ts"`
	EventIDs     []int64  `json:"eventIds"`
	// Undoable is false for changes Axiom cannot reverse from the review
	// (a restored system, or a change with conflicting sessions).
	Undoable bool `json:"undoable"`

	sessionConflict bool
}

// meaningDetail is the JSON db/meaning.go writes on meaning events.
type meaningDetail struct {
	Meaning        bool    `json:"meaning"`
	Undoes         []int64 `json:"undoes"`
	Restored       bool    `json:"restored"`
	Agent          string  `json:"agent"`
	From           string  `json:"from"`
	To             string  `json:"to"`
	FromParentID   *string `json:"fromParentId"`
	FromParentName string  `json:"fromParentName"`
	ToParentID     *string `json:"toParentId"`
	ToParentName   string  `json:"toParentName"`
	FromSystemID   *string `json:"fromSystemId"`
	FromSystemName string  `json:"fromSystemName"`
	ToSystemID     *string `json:"toSystemId"`
	ToSystemName   string  `json:"toSystemName"`
	ParentID       *string `json:"parentId"`
	ParentName     string  `json:"parentName"`
	// MovedFileIDs are the files a merge or ungroup moved.
	MovedFileIDs []string `json:"movedFileIds"`
}

func parseMeaning(ev db.StructuralEvent) meaningDetail {
	var detail meaningDetail
	_ = json.Unmarshal([]byte(ev.Detail), &detail)
	return detail
}

// IsMeaningEvent reports whether a journal row is a person's or an agent's
// meaning edit, as opposed to the indexer's or the classifier's work.
func IsMeaningEvent(ev db.StructuralEvent) bool {
	return parseMeaning(ev).Meaning
}

// withoutUndonePairs drops an edit and its undo when both fall in the window:
// changing your mind is not a change.
func withoutUndonePairs(events []db.StructuralEvent) []db.StructuralEvent {
	present := map[int64]bool{}
	for _, ev := range events {
		present[ev.ID] = true
	}
	dropped := map[int64]bool{}
	for _, ev := range events {
		detail := parseMeaning(ev)
		for _, undone := range detail.Undoes {
			if present[undone] {
				dropped[undone] = true
				dropped[ev.ID] = true
			}
		}
	}
	if len(dropped) == 0 {
		return events
	}
	kept := make([]db.StructuralEvent, 0, len(events)-len(dropped))
	for _, ev := range events {
		if !dropped[ev.ID] {
			kept = append(kept, ev)
		}
	}
	return kept
}

// meaningAccumulator folds meaning events (oldest first) into net changes.
type meaningAccumulator struct {
	moves     map[string]*MeaningChange
	moveOrder []string
	renames   map[string]*MeaningChange
	nests     map[string]*MeaningChange
	groups    map[string]*MeaningChange
	others    []*MeaningChange
}

func newMeaningAccumulator() *meaningAccumulator {
	return &meaningAccumulator{
		moves: map[string]*MeaningChange{}, renames: map[string]*MeaningChange{},
		nests: map[string]*MeaningChange{}, groups: map[string]*MeaningChange{},
	}
}

func (m *meaningAccumulator) touch(change *MeaningChange, ev db.StructuralEvent, detail meaningDetail) {
	change.Actor = mergeActor(change.Actor, ev.Actor)
	if detail.Agent != "" {
		change.Agent = detail.Agent
	}
	change.SessionID, change.sessionConflict = mergeSession(change.SessionID, change.sessionConflict, ev.SessionID)
	change.TS = ev.TS
	change.EventIDs = append(change.EventIDs, ev.ID)
	if detail.Restored {
		change.Undoable = false
	}
}

func optional(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

// add folds one event. It reports whether the event was a meaning event.
func (m *meaningAccumulator) add(ev db.StructuralEvent) bool {
	detail := parseMeaning(ev)
	if !detail.Meaning {
		return false
	}
	switch ev.Kind {
	case db.EventFileAssigned:
		change, ok := m.moves[ev.SubjectID]
		if !ok {
			change = &MeaningChange{
				Kind: "moved", SubjectID: ev.SubjectID, SubjectLabel: ev.SubjectLabel,
				FromID: optional(detail.FromSystemID), FromLabel: detail.FromSystemName, Undoable: true,
			}
			m.moves[ev.SubjectID] = change
			m.moveOrder = append(m.moveOrder, ev.SubjectID)
		}
		change.ToID, change.ToLabel = optional(detail.ToSystemID), detail.ToSystemName
		m.touch(change, ev, detail)
	case db.EventSystemRenamed:
		change, ok := m.renames[ev.SubjectID]
		if !ok {
			change = &MeaningChange{Kind: "renamed", SubjectID: ev.SubjectID, FromLabel: detail.From, Undoable: true}
			m.renames[ev.SubjectID] = change
		}
		change.SubjectLabel, change.ToLabel = ev.SubjectLabel, detail.To
		m.touch(change, ev, detail)
	case db.EventSystemNested:
		change, ok := m.nests[ev.SubjectID]
		if !ok {
			change = &MeaningChange{
				Kind: "nested", SubjectID: ev.SubjectID,
				FromID: optional(detail.FromParentID), FromLabel: detail.FromParentName, Undoable: true,
			}
			m.nests[ev.SubjectID] = change
		}
		change.SubjectLabel = ev.SubjectLabel
		change.ToID, change.ToLabel = optional(detail.ToParentID), detail.ToParentName
		m.touch(change, ev, detail)
	case db.EventSystemCreated:
		change := &MeaningChange{
			Kind: "grouped", SubjectID: ev.SubjectID, SubjectLabel: ev.SubjectLabel,
			ToID: optional(detail.ParentID), ToLabel: detail.ParentName, Undoable: true,
		}
		m.groups[ev.SubjectID] = change
		m.touch(change, ev, detail)
	case db.EventSystemDeleted:
		// The undo of a grouping; when the grouping is outside the window the
		// classifier-style "dissolved" claim reports it.
		return false
	case db.EventSystemMerged, db.EventSystemUngrouped:
		kind := "merged"
		if ev.Kind == db.EventSystemUngrouped {
			kind = "ungrouped"
		}
		change := &MeaningChange{
			Kind: kind, SubjectID: ev.SubjectID, SubjectLabel: ev.SubjectLabel,
			ToID: ev.ObjectID, ToLabel: ev.ObjectLabel, Undoable: true,
		}
		if kind == "merged" {
			change.FileIDs = detail.MovedFileIDs
		}
		m.touch(change, ev, detail)
		m.others = append(m.others, change)
	default:
		return false
	}
	return true
}

// changes returns the net meaning changes, newest first. Files moved into a
// system grouped in the same window belong to that grouping, so undoing it
// puts them back where they came from.
func (m *meaningAccumulator) changes() []MeaningChange {
	out := []MeaningChange{}
	for _, fileID := range m.moveOrder {
		move := m.moves[fileID]
		if move.FromID == move.ToID {
			continue
		}
		if group, ok := m.groups[move.ToID]; ok {
			group.FileIDs = append(group.FileIDs, move.SubjectID)
			group.FileLabels = append(group.FileLabels, move.SubjectLabel)
			group.EventIDs = append(group.EventIDs, move.EventIDs...)
			continue
		}
		out = append(out, *move)
	}
	for _, change := range m.renames {
		if change.FromLabel != change.ToLabel {
			out = append(out, *change)
		}
	}
	for _, change := range m.nests {
		if change.FromID != change.ToID {
			out = append(out, *change)
		}
	}
	for _, change := range m.groups {
		out = append(out, *change)
	}
	for _, change := range m.others {
		out = append(out, *change)
	}
	for i := range out {
		if out[i].sessionConflict {
			out[i].SessionID = ""
		}
		sort.Slice(out[i].EventIDs, func(a, b int) bool { return out[i].EventIDs[a] < out[i].EventIDs[b] })
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS > out[j].TS })
	return out
}

// ─── Claims ───────────────────────────────────────────────────────────────────

func systemOrUnsorted(label, id string) string {
	if id == "" {
		return "Unsorted"
	}
	return systemLabel(label, id)
}

func byWhom(change MeaningChange) string {
	switch {
	case change.Actor == ActorHuman:
		return "by you"
	case change.Agent != "":
		return "by " + change.Agent
	case change.Actor == ActorAgent:
		return "by an agent"
	default:
		return "by you and an agent"
	}
}

// meaningClaims turns net meaning changes into reviewable claims. Moves into
// the same system by the same actor are one claim.
func meaningClaims(summary Summary) []Claim {
	claims := []Claim{}
	type moveGroup struct {
		key   string
		moves []MeaningChange
	}
	groups := map[string]*moveGroup{}
	order := []string{}
	for _, change := range summary.Meaning {
		if change.Kind != "moved" {
			claims = append(claims, meaningClaim(change))
			continue
		}
		key := change.ToID + "\x00" + change.Actor + "\x00" + change.Agent
		group, ok := groups[key]
		if !ok {
			group = &moveGroup{key: key}
			groups[key] = group
			order = append(order, key)
		}
		group.moves = append(group.moves, change)
	}
	for _, key := range order {
		claims = append(claims, moveClaim(groups[key].moves))
	}
	return claims
}

func moveClaim(moves []MeaningChange) Claim {
	first := moves[0]
	to := systemOrUnsorted(first.ToLabel, first.ToID)
	title := fmt.Sprintf("%d files moved into %s", len(moves), to)
	if len(moves) == 1 {
		title = fmt.Sprintf("%s moved from %s to %s", first.SubjectLabel,
			systemOrUnsorted(first.FromLabel, first.FromID), to)
	}
	evidence := []Evidence{}
	fileIDs := []string{}
	eventIDs := []int64{}
	undoable := true
	ts := int64(0)
	for _, move := range moves {
		evidence = append(evidence, Evidence{
			Kind: "file.moved", Label: move.SubjectLabel,
			Detail:  systemOrUnsorted(move.FromLabel, move.FromID) + " → " + to,
			FileIDs: []string{move.SubjectID},
		})
		fileIDs = append(fileIDs, move.SubjectID)
		eventIDs = append(eventIDs, move.EventIDs...)
		undoable = undoable && move.Undoable
		if move.TS > ts {
			ts = move.TS
		}
	}
	focus := []string{}
	if first.ToID != "" {
		focus = append(focus, first.ToID)
	}
	claim := Claim{
		ID:   "claim:meaning:moved:" + first.ToID + ":" + first.Actor + ":" + first.Agent,
		Kind: ClaimMoved, Title: title, Subtitle: byWhom(first),
		Severity: claimSeverity[ClaimMoved], Score: score(claimSeverity[ClaimMoved], len(moves)),
		Actor: first.Actor, TS: ts, FocusSystemIDs: focus, FocusFileIDs: fileIDs,
		Evidence: evidence, SessionID: first.SessionID,
	}
	if undoable {
		claim.UndoEventIDs = eventIDs
	}
	return claim
}

func meaningClaim(change MeaningChange) Claim {
	var kind ClaimKind
	var title string
	focus := []string{}
	evidence := []Evidence{}
	switch change.Kind {
	case "renamed":
		kind = ClaimRenamed
		title = fmt.Sprintf("%s renamed to %s", change.FromLabel, change.ToLabel)
		focus = append(focus, change.SubjectID)
	case "nested":
		kind = ClaimNested
		if change.ToID == "" {
			title = fmt.Sprintf("%s moved to the top level", change.SubjectLabel)
		} else {
			title = fmt.Sprintf("%s now sits inside %s", change.SubjectLabel, systemLabel(change.ToLabel, change.ToID))
		}
		focus = append(focus, change.SubjectID)
	case "grouped":
		kind = ClaimGrouped
		title = fmt.Sprintf("New system · %s", change.SubjectLabel)
		if n := len(change.FileIDs); n > 0 {
			title = fmt.Sprintf("New system · %s, grouping %s", change.SubjectLabel, pluralFiles(n))
		}
		for i, fileID := range change.FileIDs {
			evidence = append(evidence, Evidence{Kind: "file.moved", Label: change.FileLabels[i], FileIDs: []string{fileID}})
		}
		focus = append(focus, change.SubjectID)
	case "merged":
		kind = ClaimMerged
		title = fmt.Sprintf("%s merged into %s", change.SubjectLabel, systemLabel(change.ToLabel, change.ToID))
		focus = append(focus, change.ToID)
	case "ungrouped":
		kind = ClaimUngrouped
		if change.ToID == "" {
			title = fmt.Sprintf("%s ungrouped; its contents moved to the top level", change.SubjectLabel)
		} else {
			title = fmt.Sprintf("%s ungrouped into %s", change.SubjectLabel, systemLabel(change.ToLabel, change.ToID))
			focus = append(focus, change.ToID)
		}
	}
	claim := Claim{
		ID: "claim:meaning:" + change.Kind + ":" + change.SubjectID, Kind: kind, Title: title,
		Subtitle: byWhom(change), Severity: claimSeverity[kind], Score: score(claimSeverity[kind], 1),
		Actor: change.Actor, TS: change.TS, FocusSystemIDs: focus, FocusFileIDs: change.FileIDs,
		Evidence: evidence, SessionID: change.SessionID,
	}
	if change.Undoable {
		claim.UndoEventIDs = change.EventIDs
	}
	return claim
}
