package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"axiom.local/archd/internal/hub"
)

// A debugger reports where it stopped in its own words; these map that back
// to the function the user is watching.

func TestStoppedFramesMapToTheWatchedFunction(t *testing.T) {
	cart := filepath.Join(string(filepath.Separator)+"src", "shop", "cart.rb")
	session := &dapLangSession{
		funcToID: map[string]string{"Shop::Cart.total": "w-total", "charge": "w-charge"},
		watches: []Watch{
			{ID: "w-class", AbsPath: cart, LineStart: 1, LineEnd: 40},
			{ID: "w-method", AbsPath: cart, LineStart: 8, LineEnd: 12},
		},
	}
	for frame, want := range map[string]string{
		"Shop::Cart.total":             "w-total",
		"process::charge(int, double)": "w-charge",
		"Billing.charge":               "w-charge",
		"refund":                       "",
	} {
		if got := session.matchFunc(frame); got != want {
			t.Errorf("matchFunc(%q) = %q, want %q", frame, got, want)
		}
	}
	// The narrowest watch containing the line wins; the case of the path does not matter.
	if got := session.matchSource(strings.ToUpper(cart), 9); got != "w-method" {
		t.Errorf("line 9 → %q, want the method", got)
	}
	if got := session.matchSource(cart, 30); got != "w-class" {
		t.Errorf("line 30 → %q, want the class", got)
	}
	if got := session.matchStoppedLocation("BP - Line  " + cart + ":10 (call)"); got != "w-method" {
		t.Errorf("rdbg description → %q", got)
	}
	if got := session.matchStoppedLocation("paused"); got != "" {
		t.Errorf("a description without a location matched %q", got)
	}
}

func TestEditorsAreTakenOffTheDebuggersPath(t *testing.T) {
	sep := string(os.PathListSeparator)
	env := envWithoutEditors([]string{
		"HOME=/home/me",
		"PATH=" + strings.Join([]string{`C:\Program Files\Microsoft VS Code\bin`, "/usr/bin", `C:\Users\me\AppData\Local\Programs\code\bin`}, sep),
	})
	if env[0] != "HOME=/home/me" {
		t.Fatalf("other variables changed: %v", env)
	}
	if strings.Contains(strings.ToLower(env[1]), "vs code") || !strings.Contains(env[1], "/usr/bin") {
		t.Fatalf("PATH = %q", env[1])
	}
}

func TestARecordingStartsTakesNotesAndStops(t *testing.T) {
	m := NewManager(hub.New())
	if _, ok := m.AnnotateInvestigation("ws", "nothing is recording"); ok {
		t.Fatal("a note was taken with no recording")
	}
	inv := m.StartInvestigation("ws", "", "", "", "human")
	if !strings.HasPrefix(inv.Name, "Investigation ") || inv.Status != "recording" {
		t.Fatalf("started = %+v", inv)
	}
	if _, ok := m.AnnotateInvestigation("ws", "tax is computed twice", Anchor{Symbol: "tax"}); !ok {
		t.Fatal("the note was refused")
	}
	if active := m.ActiveInvestigation("ws"); active == nil || active.Events != nil || len(active.Notes) != 1 {
		t.Fatalf("active = %+v", active)
	}
	stopped := m.StopInvestigation("ws")
	if stopped == nil || stopped.Status != "saved" || m.ActiveInvestigation("ws") != nil {
		t.Fatalf("stopped = %+v", stopped)
	}
	if m.StopInvestigation("ws") != nil {
		t.Fatal("stopping twice returned a recording")
	}
}
