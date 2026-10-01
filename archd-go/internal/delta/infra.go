package delta

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"axiom.local/archd/internal/db"
)

// Infrastructure changes in the delta (WORK infra-claims): code that starts or
// stops reading, writing, publishing to or calling a piece of infrastructure.
// "Orders now writes to Redis" is as architectural as "Orders now depends on
// Payments" - often more, because it is where data and money go.
//
// The journal rows are infra.linked / infra.unlinked: subject is the code
// (a file, or a system when someone connects one directly), object is the
// infrastructure node.

const (
	ClaimInfraLinked   ClaimKind = "infra.linked"
	ClaimInfraUnlinked ClaimKind = "infra.unlinked"
)

func init() {
	claimSeverity[ClaimInfraLinked] = 6
	claimSeverity[ClaimInfraUnlinked] = 5
}

// InfraDetail is the JSON written on infra.linked / infra.unlinked rows.
type InfraDetail struct {
	Relationship  string `json:"relationship"`
	Item          string `json:"item,omitempty"`
	SrcSystem     string `json:"srcSystem,omitempty"`
	SrcSystemName string `json:"srcSystemName,omitempty"`
}

// InfraChange is one relationship's net change in the window.
type InfraChange struct {
	SrcID        string `json:"srcId"`
	SrcLabel     string `json:"srcLabel"`
	InfraID      string `json:"infraId"`
	InfraName    string `json:"infraName"`
	Relationship string `json:"relationship"`
	Item         string `json:"item,omitempty"`
	SystemID     string `json:"systemId,omitempty"`
	SystemName   string `json:"systemName,omitempty"`
	Change       string `json:"change"` // added | removed
	Actor        string `json:"actor"`
	TS           int64  `json:"ts"`
	SessionID    string `json:"sessionId,omitempty"`
}

type infraState struct {
	InfraChange
	added, removed  bool
	sessionConflict bool
}

type infraAccumulator struct {
	states map[string]*infraState
	order  []string
}

func newInfraAccumulator() *infraAccumulator {
	return &infraAccumulator{states: map[string]*infraState{}}
}

// add takes an infra row; it reports false for every other kind.
func (a *infraAccumulator) add(ev db.StructuralEvent) bool {
	if ev.Kind != db.EventInfraLinked && ev.Kind != db.EventInfraUnlinked {
		return false
	}
	var detail InfraDetail
	_ = json.Unmarshal([]byte(ev.Detail), &detail)
	key := strings.Join([]string{ev.SubjectID, ev.ObjectID, detail.Relationship, detail.Item}, "\x00")
	state, ok := a.states[key]
	if !ok {
		state = &infraState{}
		a.states[key] = state
		a.order = append(a.order, key)
	}
	state.SrcID, state.SrcLabel = ev.SubjectID, ev.SubjectLabel
	state.InfraID, state.InfraName = ev.ObjectID, ev.ObjectLabel
	state.Relationship, state.Item = detail.Relationship, detail.Item
	if detail.SrcSystem != "" {
		state.SystemID, state.SystemName = detail.SrcSystem, detail.SrcSystemName
	}
	state.Actor = mergeActor(state.Actor, ev.Actor)
	state.TS = ev.TS
	state.SessionID, state.sessionConflict = mergeSession(state.SessionID, state.sessionConflict, ev.SessionID)
	if ev.Kind == db.EventInfraLinked {
		// Linked after being unlinked in the same window is no net change.
		if state.removed {
			state.removed = false
		} else {
			state.added = true
		}
	} else if state.added {
		state.added = false
	} else {
		state.removed = true
	}
	return true
}

func (a *infraAccumulator) changes() []InfraChange {
	out := []InfraChange{}
	for _, key := range a.order {
		state := a.states[key]
		switch {
		case state.added:
			state.Change = "added"
		case state.removed:
			state.Change = "removed"
		default:
			continue
		}
		if state.sessionConflict {
			state.SessionID = ""
		}
		out = append(out, state.InfraChange)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS > out[j].TS })
	return out
}

// infraVerb says a relationship the way a person would: "writes to Redis".
func infraVerb(relationship string) string {
	switch strings.ToUpper(relationship) {
	case "READS":
		return "reads from"
	case "WRITES":
		return "writes to"
	case "PUBLISHES":
		return "publishes to"
	case "SUBSCRIBES", "CONSUMES":
		return "consumes from"
	case "CALLS":
		return "calls"
	case "STORES":
		return "stores files in"
	default:
		return "uses"
	}
}

// infraClaims groups the changes by who (a system, or a file outside every
// system), what infrastructure, how, and in which direction.
func infraClaims(summary Summary) []Claim {
	type group struct {
		claim    Claim
		changes  []InfraChange
		files    map[string]bool
		session  string
		conflict bool
	}
	groups := map[string]*group{}
	order := []string{}
	for _, change := range summary.Infra {
		who, whoID := change.SystemName, change.SystemID
		if whoID == "" {
			who, whoID = change.SrcLabel, change.SrcID
		}
		key := strings.Join([]string{change.Change, whoID, change.InfraID, strings.ToUpper(change.Relationship)}, "\x00")
		g, ok := groups[key]
		if !ok {
			kind, verb := ClaimInfraLinked, "now "+infraVerb(change.Relationship)
			if change.Change == "removed" {
				kind, verb = ClaimInfraUnlinked, "no longer "+infraVerb(change.Relationship)
			}
			g = &group{files: map[string]bool{}, claim: Claim{
				ID:       fmt.Sprintf("%s:%s:%s:%s", kind, whoID, change.InfraID, strings.ToLower(change.Relationship)),
				Kind:     kind,
				Title:    fmt.Sprintf("%s %s %s", systemLabel(who, whoID), verb, change.InfraName),
				Severity: claimSeverity[kind],
			}}
			if change.SystemID != "" {
				g.claim.FocusSystemIDs = []string{change.SystemID}
			}
			groups[key] = g
			order = append(order, key)
		}
		g.changes = append(g.changes, change)
		g.claim.Actor = mergeActor(g.claim.Actor, change.Actor)
		g.session, g.conflict = mergeSession(g.session, g.conflict, change.SessionID)
		if change.TS > g.claim.TS {
			g.claim.TS = change.TS
		}
		label := change.SrcLabel
		if change.Item != "" {
			label += " → " + change.Item
		}
		evidence := Evidence{Kind: "infra." + change.Change, Label: label, Detail: strings.ToUpper(change.Relationship)}
		if change.SrcID != change.SystemID {
			evidence.FileIDs = []string{change.SrcID}
			if !g.files[change.SrcID] {
				g.files[change.SrcID] = true
				g.claim.FocusFileIDs = append(g.claim.FocusFileIDs, change.SrcID)
			}
		}
		g.claim.Evidence = append(g.claim.Evidence, evidence)
	}
	claims := []Claim{}
	for _, key := range order {
		g := groups[key]
		if !g.conflict {
			g.claim.SessionID = g.session
		}
		items := []string{}
		seenItem := map[string]bool{}
		for _, change := range g.changes {
			if change.Item != "" && !seenItem[change.Item] {
				seenItem[change.Item] = true
				items = append(items, change.Item)
			}
		}
		switch {
		case len(items) > 3:
			g.claim.Subtitle = fmt.Sprintf("%s and %d more", strings.Join(items[:3], ", "), len(items)-3)
		case len(items) > 0:
			g.claim.Subtitle = strings.Join(items, ", ")
		case len(g.files) > 0:
			g.claim.Subtitle = pluralFiles(len(g.files))
		}
		g.claim.Score = score(g.claim.Severity, len(g.claim.Evidence))
		claims = append(claims, g.claim)
	}
	return claims
}
