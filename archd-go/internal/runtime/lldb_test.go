package runtime

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"axiom.local/archd/internal/hub"
)

// C/C++ under whichever debugger the machine has: gdb, or lldb-dap (macOS
// ships it with the command line tools; there is no gdb there).
func TestCppCallsRecordedUnderTheSystemDebugger(t *testing.T) {
	compiler, err := exec.LookPath("clang++")
	if err != nil {
		if compiler, err = exec.LookPath("g++"); err != nil {
			t.Skip("no C++ compiler")
		}
	}
	dbg, err := findCppDebugger()
	if err != nil {
		t.Skip(err.Error())
	}
	if isLLDB(dbg) && macOSDebuggingBlocked() {
		t.Skip(macOSDebuggingHint)
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "calc.cpp")
	if err := os.WriteFile(src, []byte("#include <cstdio>\nint add(int a, int b) { return a + b; }\nint main() { int s = 0; for (int i = 0; i < 3; i++) s = add(s, i); std::printf(\"%d\\n\", s); return 0; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "calc")
	if out, err := exec.Command(compiler, "-g", "-O0", "-o", bin, src).CombinedOutput(); err != nil {
		t.Fatalf("compile: %v\n%s", err, out)
	}
	m := NewManager(hub.New())
	w := &Watch{WorkspaceID: "ws", FileID: "calc", AbsPath: src, RelPath: "calc.cpp", Symbol: "add", LineStart: 2, LineEnd: 2}
	m.AddWatch(w)
	sess, err := m.LaunchLangTarget("ws", "cpp", bin, nil)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		sess.mu.Lock()
		status := sess.Status
		sess.mu.Unlock()
		if status != "starting" && status != "running" && status != "connected" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	watches := m.WatchesForWorkspace("ws")
	if len(watches) != 1 || watches[0].CallCount != 3 {
		t.Fatalf("add is called three times: %+v (session %+v)", watches, sess.dto())
	}
	if !strings.Contains(string(watches[0].LastArgs), "a") {
		t.Errorf("arguments come back: %s", watches[0].LastArgs)
	}
}
