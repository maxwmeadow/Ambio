package runtime

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"axiom.local/archd/internal/hub"
)

// A watched C++ function, traced through gdb's DAP mode: every call is counted
// with its arguments. Skipped where gdb (with DAP, 14+) or g++ is missing.
func TestGdbRecordsEveryCallToAWatchedCppFunction(t *testing.T) {
	if _, err := langConfigs["cpp"].findDebugger(); err != nil {
		t.Skip(err)
	}
	compiler, err := exec.LookPath("g++")
	if err != nil {
		t.Skip("g++ not installed")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "pay.cpp")
	program := filepath.Join(dir, "pay")
	if err := os.WriteFile(source, []byte(`#include <cstdio>
__attribute__((noinline)) double process_payment(int id, double amount) { return amount * 1.1 + id; }
int main() {
  double total = 0;
  for (int i = 1; i <= 3; i++) total += process_payment(i, 10.0 * i);
  std::printf("%f\n", total);
  return 0;
}
`), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(compiler, "-g", "-O0", "-o", program, source).CombinedOutput(); err != nil {
		t.Fatalf("compile: %v\n%s", err, out)
	}
	m := NewManager(hub.New())
	m.AddWatch(&Watch{ID: "w1", WorkspaceID: "ws", Symbol: "process_payment", RelPath: "pay.cpp", AbsPath: source})
	session, err := m.LaunchLangTarget("ws", "cpp", program, nil)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	t.Cleanup(func() { _, _ = m.StopLangTarget(session.ID) })

	deadline := time.Now().Add(60 * time.Second)
	for {
		watches := m.WatchesForWorkspace("ws")
		if len(watches) == 1 && watches[0].CallCount == 3 {
			t.Logf("last args: %s", watches[0].LastArgs)
			if len(watches[0].LastArgs) == 0 {
				t.Fatal("calls were counted without their arguments")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls counted: %+v", watches)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
