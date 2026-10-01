package runtime

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"axiom.local/archd/internal/hub"
)

// A watched Go function, traced through a real delve: every call is counted
// with its arguments. Skipped where delve is not installed.
func TestDelveRecordsEveryCallToAWatchedGoFunction(t *testing.T) {
	if _, err := findDelve(); err != nil {
		t.Skip(err)
	}
	dir := t.TempDir()
	main := filepath.Join(dir, "main.go")
	for name, body := range map[string]string{
		"go.mod":  "module demo\n\ngo 1.22\n",
		"main.go": "package main\n\nimport \"fmt\"\n\n//go:noinline\nfunc process(n int) int { return n * 2 }\n\nfunc main() {\n\ttotal := 0\n\tfor i := 1; i <= 3; i++ {\n\t\ttotal += process(i)\n\t}\n\tfmt.Println(total)\n}\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(hub.New())
	m.AddWatch(&Watch{ID: "w1", WorkspaceID: "ws", Symbol: "process", RelPath: "main.go", AbsPath: main})
	session, err := m.LaunchGoTarget("ws", dir, nil)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	t.Cleanup(func() { _, _ = m.StopGoTarget(session.ID) })

	deadline := time.Now().Add(90 * time.Second)
	for {
		watches := m.WatchesForWorkspace("ws")
		if len(watches) == 1 && watches[0].CallCount == 3 {
			if len(watches[0].LastArgs) == 0 {
				t.Fatal("calls were counted without their arguments")
			}
			t.Logf("last args: %s", watches[0].LastArgs)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls counted: %+v (session %s %s)", watches, session.Status, session.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
