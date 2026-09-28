// The case file: the structure of an investigation, as opposed to its raw
// timeline.
//
// A debugging session is hypotheses tested by experiments. The timeline
// (Events) records everything in order for replay; the case fields hold the
// current state of the argument - what is suspected, what each run showed,
// what was concluded - so the canvas can show it at a glance and the agent can
// be reminded where it stands.
//
// It is also the human's channel into the session. Messages the watcher sends
// queue here and ride back to the agent on its next investigation call. That
// works in every MCP client, because every client shows the agent its tool
// results; no client-specific push mechanism is needed.
package runtime

import (
	"fmt"
	"strings"
	"time"
)

// Anchor ties a case entry to the map: a file node, optionally a symbol in it.
type Anchor struct {
	FileID  string `json:"fileId,omitempty"`
	RelPath string `json:"relPath,omitempty"`
	Symbol  string `json:"symbol,omitempty"`
	Line    int    `json:"line,omitempty"`
}

// Hypothesis is one suspected explanation and how it has fared.
type Hypothesis struct {
	ID        string   `json:"id"` // H1, H2, ...
	Text      string   `json:"text"`
	Anchors   []Anchor `json:"anchors,omitempty"`
	Status    string   `json:"status"` // open | confirmed | refuted | inconclusive
	Verdict   string   `json:"verdict,omitempty"`
	RunIDs    []string `json:"runIds,omitempty"`
	CreatedAt int64    `json:"createdAt"`
	DecidedAt int64    `json:"decidedAt,omitempty"`
}

// Conclusion closes the case.
type Conclusion struct {
	RootCause string   `json:"rootCause"`
	Anchors   []Anchor `json:"anchors,omitempty"`
	Fix       string   `json:"fix,omitempty"`
	Verified  string   `json:"verified,omitempty"` // run id that proved the fix
	At        int64    `json:"at"`
}

// HumanMessage is something the person watching said to the agent.
type HumanMessage struct {
	ID          string  `json:"id"`
	Text        string  `json:"text"`
	Anchor      *Anchor `json:"anchor,omitempty"`
	At          int64   `json:"at"`
	DeliveredAt int64   `json:"deliveredAt,omitempty"`
}

// RunRef is the case's index of the experiments it ran. The full evidence is
// in the timeline's investigation:run event.
type RunRef struct {
	ID           string `json:"id"`
	N            int    `json:"n"`
	Command      string `json:"command"`
	ExitCode     int    `json:"exitCode"`
	TimedOut     bool   `json:"timedOut"`
	DurationMs   int64  `json:"durationMs"`
	HypothesisID string `json:"hypothesisId,omitempty"`
	Headline     string `json:"headline,omitempty"`
	At           int64  `json:"at"`
}

var hypothesisStatuses = map[string]bool{"open": true, "confirmed": true, "refuted": true, "inconclusive": true}

// ErrNoCase is returned when an operation needs an active investigation.
var ErrNoCase = fmt.Errorf("no investigation is open")

func (m *Manager) withCase(workspaceID string, fn func(inv *Investigation) error) error {
	m.captureMu.Lock()
	defer m.captureMu.Unlock()
	inv := m.activeInvestigations[workspaceID]
	if inv == nil {
		return ErrNoCase
	}
	return fn(inv)
}

// SetSymptom records what the investigation is trying to explain.
func (m *Manager) SetSymptom(workspaceID, symptom string) {
	_ = m.withCase(workspaceID, func(inv *Investigation) error {
		inv.Symptom = symptom
		return nil
	})
}

// AddHypothesis opens a new hypothesis on the active case.
func (m *Manager) AddHypothesis(workspaceID, text string, anchors []Anchor) (*Hypothesis, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("a hypothesis needs text: what you suspect, in one sentence")
	}
	var h Hypothesis
	err := m.withCase(workspaceID, func(inv *Investigation) error {
		h = Hypothesis{
			ID:        fmt.Sprintf("H%d", len(inv.Hypotheses)+1),
			Text:      text,
			Anchors:   anchors,
			Status:    "open",
			CreatedAt: time.Now().UnixMilli(),
		}
		inv.Hypotheses = append(inv.Hypotheses, h)
		return nil
	})
	if err != nil {
		return nil, err
	}
	m.hub.Broadcast("investigation:hypothesis", map[string]any{
		"workspaceId": workspaceID,
		"hypothesis":  h,
	})
	return &h, nil
}

// findHypothesis resolves "H2", "h2", "2" or exact text. Caller holds the lock.
func findHypothesis(inv *Investigation, ref string) *Hypothesis {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil
	}
	norm := strings.ToUpper(ref)
	if !strings.HasPrefix(norm, "H") {
		norm = "H" + norm
	}
	for i := range inv.Hypotheses {
		if inv.Hypotheses[i].ID == norm || inv.Hypotheses[i].Text == ref {
			return &inv.Hypotheses[i]
		}
	}
	return nil
}

// SetVerdict records whether evidence confirmed or ruled out a hypothesis.
func (m *Manager) SetVerdict(workspaceID, ref, status, text, runID string) (*Hypothesis, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "ruled out", "ruled_out", "rejected", "false":
		status = "refuted"
	case "true", "yes", "proven":
		status = "confirmed"
	}
	if !hypothesisStatuses[status] || status == "open" {
		return nil, fmt.Errorf("result must be confirmed, refuted or inconclusive (got %q)", status)
	}
	var out Hypothesis
	err := m.withCase(workspaceID, func(inv *Investigation) error {
		h := findHypothesis(inv, ref)
		if h == nil {
			ids := make([]string, 0, len(inv.Hypotheses))
			for _, x := range inv.Hypotheses {
				ids = append(ids, x.ID)
			}
			if len(ids) == 0 {
				return fmt.Errorf("no hypotheses yet - state one with op \"hypothesis\" first")
			}
			return fmt.Errorf("hypothesis %q not found (have %s)", ref, strings.Join(ids, ", "))
		}
		h.Status = status
		h.Verdict = strings.TrimSpace(text)
		h.DecidedAt = time.Now().UnixMilli()
		if runID != "" && !contains(h.RunIDs, runID) {
			h.RunIDs = append(h.RunIDs, runID)
		}
		out = *h
		return nil
	})
	if err != nil {
		return nil, err
	}
	m.hub.Broadcast("investigation:verdict", map[string]any{
		"workspaceId": workspaceID,
		"hypothesis":  out,
	})
	return &out, nil
}

// RecordRun indexes a finished run on the case and links it to a hypothesis.
func (m *Manager) RecordRun(workspaceID string, ref RunRef) (RunRef, error) {
	err := m.withCase(workspaceID, func(inv *Investigation) error {
		ref.N = len(inv.Runs) + 1
		if ref.HypothesisID != "" {
			if h := findHypothesis(inv, ref.HypothesisID); h != nil {
				ref.HypothesisID = h.ID
				if !contains(h.RunIDs, ref.ID) {
					h.RunIDs = append(h.RunIDs, ref.ID)
				}
			} else {
				ref.HypothesisID = ""
			}
		}
		inv.Runs = append(inv.Runs, ref)
		return nil
	})
	return ref, err
}

// Conclude records the root cause. The recording stays open until stopped, so
// a fix and the run that verifies it can still be captured.
func (m *Manager) Conclude(workspaceID string, c Conclusion) (*Conclusion, error) {
	if strings.TrimSpace(c.RootCause) == "" {
		return nil, fmt.Errorf("rootCause is required: what is actually wrong, in one or two sentences")
	}
	c.At = time.Now().UnixMilli()
	err := m.withCase(workspaceID, func(inv *Investigation) error {
		if c.Verified != "" {
			found := false
			for _, r := range inv.Runs {
				if r.ID == c.Verified || fmt.Sprintf("R%d", r.N) == strings.ToUpper(c.Verified) {
					c.Verified = r.ID
					found = true
				}
			}
			if !found {
				c.Verified = ""
			}
		}
		inv.Conclusion = &c
		return nil
	})
	if err != nil {
		return nil, err
	}
	m.hub.Broadcast("investigation:conclusion", map[string]any{
		"workspaceId": workspaceID,
		"conclusion":  c,
	})
	return &c, nil
}

// QueueHumanMessage stores a message from the watcher for the agent.
func (m *Manager) QueueHumanMessage(workspaceID, text string, anchor *Anchor) (*HumanMessage, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("message text is required")
	}
	msg := HumanMessage{ID: shortID(), Text: text, Anchor: anchor, At: time.Now().UnixMilli()}
	err := m.withCase(workspaceID, func(inv *Investigation) error {
		inv.Messages = append(inv.Messages, msg)
		return nil
	})
	if err != nil {
		return nil, err
	}
	m.hub.Broadcast("investigation:message", map[string]any{
		"workspaceId": workspaceID,
		"message":     msg,
	})
	return &msg, nil
}

// TakePendingMessages returns undelivered human messages and marks them
// delivered, so each reaches the agent exactly once.
func (m *Manager) TakePendingMessages(workspaceID string) []HumanMessage {
	var out []HumanMessage
	_ = m.withCase(workspaceID, func(inv *Investigation) error {
		now := time.Now().UnixMilli()
		for i := range inv.Messages {
			if inv.Messages[i].DeliveredAt == 0 {
				inv.Messages[i].DeliveredAt = now
				out = append(out, inv.Messages[i])
			}
		}
		return nil
	})
	if len(out) > 0 {
		ids := make([]string, len(out))
		for i, msg := range out {
			ids[i] = msg.ID
		}
		m.hub.Broadcast("investigation:message_delivered", map[string]any{
			"workspaceId": workspaceID,
			"ids":         ids,
		})
	}
	return out
}

// CaseState is the case file without the timeline.
type CaseState struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Symptom    string         `json:"symptom,omitempty"`
	Hypotheses []Hypothesis   `json:"hypotheses"`
	Runs       []RunRef       `json:"runs"`
	Conclusion *Conclusion    `json:"conclusion,omitempty"`
	Messages   []HumanMessage `json:"messages"`
	DurationMs int64          `json:"durationMs"`
}

// Case returns the active case file, or nil.
func (m *Manager) Case(workspaceID string) *CaseState {
	var out *CaseState
	_ = m.withCase(workspaceID, func(inv *Investigation) error {
		out = &CaseState{
			ID:         inv.ID,
			Name:       inv.Name,
			Symptom:    inv.Symptom,
			Hypotheses: append([]Hypothesis{}, inv.Hypotheses...),
			Runs:       append([]RunRef{}, inv.Runs...),
			Conclusion: inv.Conclusion,
			Messages:   append([]HumanMessage{}, inv.Messages...),
			DurationMs: time.Since(inv.start).Milliseconds(),
		}
		return nil
	})
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
