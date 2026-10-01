package api

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
)

// mapBriefing is what a person changed about the map since this agent last
// worked here, handed over when it starts work, so it builds on those
// decisions instead of reversing them (WORK `agents-see-human-changes`).
type mapBriefing struct {
	Since   int64               `json:"since"`
	Changes []mapBriefingChange `json:"changes"`
	// Decisions are the person's verdicts on agents' proposals, with why.
	Decisions []mapBriefingChange `json:"decisions,omitempty"`
	Code      []db.CodeFitFinding `json:"codeDisagrees,omitempty"`
}

type mapBriefingChange struct {
	What string `json:"what"`
	At   int64  `json:"at"`
}

// briefingWindow is how far back an agent with no earlier session looks.
const briefingWindow = 7 * 24 * time.Hour

// mapChangesSince builds the briefing for an agent about to start work: the
// person's meaning edits since that agent's previous session began (or the
// last week for an agent not seen before), and where the code still
// disagrees with them. It returns nil when there is nothing to tell.
func mapChangesSince(sqlDB *sql.DB, workspaceID, agent string, now time.Time) *mapBriefing {
	since := now.Add(-briefingWindow).UnixMilli()
	if agent != "" {
		var previous sql.NullInt64
		if err := sqlDB.QueryRow(`SELECT MAX(started_at) FROM work_sessions WHERE workspace_id = ? AND agent = ?`,
			workspaceID, agent).Scan(&previous); err == nil && previous.Valid && previous.Int64 > 0 {
			since = previous.Int64
		}
	}
	events, err := db.GetStructuralEvents(sqlDB, workspaceID, since)
	if err != nil {
		return nil
	}
	human := []db.StructuralEvent{}
	briefing := &mapBriefing{Since: since, Changes: []mapBriefingChange{}}
	for _, ev := range events {
		if ev.Actor != "human" {
			continue
		}
		if ev.Kind == db.EventProposalDecided {
			briefing.Decisions = append(briefing.Decisions, mapBriefingChange{What: decisionSentence(ev), At: ev.TS})
		} else if delta.IsMeaningEvent(ev) {
			human = append(human, ev)
		}
	}
	summary := delta.Aggregate(human, since, now.UnixMilli())
	for _, claim := range delta.BuildClaims(summary, nil) {
		if strings.HasPrefix(string(claim.Kind), "meaning.") {
			briefing.Changes = append(briefing.Changes, mapBriefingChange{What: claim.Title, At: claim.TS})
		}
	}
	if len(briefing.Changes) == 0 && len(briefing.Decisions) == 0 {
		return nil
	}
	fileIDs := []string{}
	for _, change := range summary.Meaning {
		fileIDs = append(fileIDs, meaningChangeFiles(change)...)
	}
	if findings, err := db.CodeFit(sqlDB, workspaceID, fileIDs); err == nil {
		briefing.Code = findings
	}
	return briefing
}

// decisionSentence says what was decided about a proposal, and why when known:
// "The user rejected the proposed system Job Queue on Agent Plan: we use SQS".
func decisionSentence(ev db.StructuralEvent) string {
	var detail struct {
		Decision, Reason, Kind, SheetName string
	}
	_ = json.Unmarshal([]byte(ev.Detail), &detail)
	verb := "confirmed"
	if detail.Decision == "rejected" {
		verb = "rejected"
	}
	sentence := "The user " + verb + " the proposed " + strings.TrimSpace(detail.Kind+" "+ev.SubjectLabel)
	if detail.SheetName != "" {
		sentence += " on " + detail.SheetName
	}
	if detail.Reason != "" {
		sentence += ": " + detail.Reason
	}
	return sentence
}
