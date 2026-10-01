package runtime

import (
	"errors"
	"strings"
	"testing"

	"axiom.local/archd/internal/hub"
)

// An investigation is a case file: hypotheses, the runs that test them, and a
// conclusion. These are the rules an agent and the watching human rely on.

func TestACaseNeedsAnOpenInvestigation(t *testing.T) {
	m := NewManager(hub.New())
	if _, err := m.AddHypothesis("ws", "the cache is stale", nil); !errors.Is(err, ErrNoCase) {
		t.Fatalf("hypothesis without a case: %v", err)
	}
	if m.Case("ws") != nil {
		t.Fatal("a case exists before any investigation")
	}
}

func TestHypothesesVerdictsRunsAndConclusion(t *testing.T) {
	m := NewManager(hub.New())
	m.StartInvestigation("ws", "", "abc123", "main", "agent")
	m.SetSymptom("ws", "checkout totals are off by one cent")

	if _, err := m.AddHypothesis("ws", "   ", nil); err == nil {
		t.Fatal("an empty hypothesis was accepted")
	}
	h1, err := m.AddHypothesis("ws", "rounding happens per line", []Anchor{{RelPath: "cart.ts", Symbol: "total"}})
	if err != nil || h1.ID != "H1" || h1.Status != "open" {
		t.Fatalf("H1 = %+v, %v", h1, err)
	}
	h2, _ := m.AddHypothesis("ws", "tax uses floats", nil)
	if h2.ID != "H2" {
		t.Fatalf("second hypothesis is %s", h2.ID)
	}

	// A run is numbered on the case and linked to the hypothesis it tests,
	// however the hypothesis is named.
	run, err := m.RecordRun("ws", RunRef{ID: "run-a", Command: "npm test", HypothesisID: "h2"})
	if err != nil || run.N != 1 || run.HypothesisID != "H2" {
		t.Fatalf("run = %+v, %v", run, err)
	}
	if orphan, _ := m.RecordRun("ws", RunRef{ID: "run-b", HypothesisID: "H9"}); orphan.N != 2 || orphan.HypothesisID != "" {
		t.Fatalf("a run for an unknown hypothesis kept the link: %+v", orphan)
	}

	// Verdicts accept the words people use, and nothing else.
	if v, err := m.SetVerdict("ws", "2", "ruled out", "floats are not used", "run-a"); err != nil || v.Status != "refuted" {
		t.Fatalf("ruled out → %+v, %v", v, err)
	}
	if v, err := m.SetVerdict("ws", "rounding happens per line", "proven", "", ""); err != nil || v.Status != "confirmed" || v.ID != "H1" {
		t.Fatalf("by text → %+v, %v", v, err)
	}
	if _, err := m.SetVerdict("ws", "H1", "open", "", ""); err == nil {
		t.Fatal("a verdict of open was accepted")
	}
	if _, err := m.SetVerdict("ws", "H7", "confirmed", "", ""); err == nil || !strings.Contains(err.Error(), "have H1, H2") {
		t.Fatalf("unknown hypothesis: %v", err)
	}
	if got := m.Case("ws").Hypotheses[1].RunIDs; len(got) != 1 || got[0] != "run-a" {
		t.Fatalf("the run is linked twice or not at all: %v", got)
	}

	// A conclusion names a verifying run by number; an unknown one is dropped.
	if _, err := m.Conclude("ws", Conclusion{RootCause: " "}); err == nil {
		t.Fatal("a conclusion without a root cause was accepted")
	}
	c, err := m.Conclude("ws", Conclusion{RootCause: "per-line rounding", Verified: "r1"})
	if err != nil || c.Verified != "run-a" {
		t.Fatalf("conclusion = %+v, %v", c, err)
	}
	if c, _ := m.Conclude("ws", Conclusion{RootCause: "per-line rounding", Verified: "R9"}); c.Verified != "" {
		t.Fatalf("an unknown verifying run was kept: %q", c.Verified)
	}

	state := m.Case("ws")
	if state.Symptom == "" || len(state.Runs) != 2 || state.Conclusion == nil || state.Origin != "agent" {
		t.Fatalf("case = %+v", state)
	}
	// The case returned is a copy.
	state.Hypotheses[0].Status = "open"
	if m.Case("ws").Hypotheses[0].Status != "confirmed" {
		t.Fatal("changing a returned case changed the investigation")
	}
}

func TestAHumanMessageReachesTheAgentExactlyOnce(t *testing.T) {
	m := NewManager(hub.New())
	m.StartInvestigation("ws", "slow checkout", "", "", "human")
	if _, err := m.QueueHumanMessage("ws", "  ", nil); err == nil {
		t.Fatal("an empty message was queued")
	}
	if _, err := m.QueueHumanMessage("ws", "look at the tax call", &Anchor{Symbol: "tax"}); err != nil {
		t.Fatal(err)
	}
	if first := m.TakePendingMessages("ws"); len(first) != 1 || first[0].Text != "look at the tax call" {
		t.Fatalf("first take = %+v", first)
	}
	if again := m.TakePendingMessages("ws"); len(again) != 0 {
		t.Fatalf("a message was delivered twice: %+v", again)
	}
	if msgs := m.Case("ws").Messages; len(msgs) != 1 || msgs[0].DeliveredAt == 0 {
		t.Fatalf("delivery not recorded: %+v", msgs)
	}
}
