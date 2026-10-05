package runtime

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ambio.local/archd/internal/hub"
)

// A watched Ruby method, traced through rdbg: every call is counted (Ruby is
// call-only - see rubyConfig). Skipped where ruby or the debug gem is missing.
func TestRdbgCountsEveryCallToAWatchedRubyMethod(t *testing.T) {
	if _, err := langConfigs["ruby"].findDebugger(); err != nil {
		t.Skip(err)
	}
	if os.Getenv("AMBIO_RDBG_PATH") == "" {
		out, err := exec.Command("gem", "contents", "debug").Output()
		if err != nil {
			t.Skip("the debug gem is not installed")
		}
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasSuffix(line, "/exe/rdbg") {
				t.Setenv("AMBIO_RDBG_PATH", line)
			}
		}
		if os.Getenv("AMBIO_RDBG_PATH") == "" {
			t.Skip("rdbg not found in the debug gem")
		}
	}
	// Behind a symlink, as macOS's temp folder is (/var -> /private/var): the
	// breakpoint and the reported stop must still name the watched file.
	dir := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(t.TempDir(), dir); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(dir, "app", "pay.rb")
	if err := os.WriteFile(program, []byte("def process_payment(id, amount)\n  amount * 1.1 + id\nend\n\ntotal = 0\n(1..3).each { |i| total += process_payment(i, 10.0 * i) }\nputs total\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(hub.New())
	m.AddWatch(&Watch{ID: "w1", WorkspaceID: "ws", Symbol: "process_payment", RelPath: "app/pay.rb", AbsPath: program, LineStart: 1, LineEnd: 3})
	session, err := m.LaunchLangTarget("ws", "ruby", program, nil)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	t.Cleanup(func() { _, _ = m.StopLangTarget(session.ID) })

	deadline := time.Now().Add(60 * time.Second)
	for {
		watches := m.WatchesForWorkspace("ws")
		if len(watches) == 1 && watches[0].CallCount == 3 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls counted: %+v", watches)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// rdbg resolves a relative breakpoint against its cwd, the program's folder,
// and runs a program under /var/… as /private/var/… on macOS, so both the
// breakpoints and the program are passed as one absolute, symlink-free path.
func TestRdbgArgvNamesFilesByResolvedAbsolutePath(t *testing.T) {
	real := t.TempDir()
	if err := os.Mkdir(filepath.Join(real, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "app", "pay.rb"), []byte("def pay; end\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(real, linked); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	want, err := filepath.EvalSymlinks(filepath.Join(real, "app", "pay.rb"))
	if err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(linked, "app", "pay.rb")
	argv := rubyConfig.buildArgv("ruby", 4711, program, nil, []Watch{{RelPath: "app/pay.rb", AbsPath: program, LineStart: 1}})
	joined := strings.Join(argv, " ")
	if !strings.Contains(joined, "break "+filepath.ToSlash(want)+":1") {
		t.Errorf("breakpoint should name %s: %v", want, argv)
	}
	if argv[len(argv)-1] != want {
		t.Errorf("program should be %s, got %s", want, argv[len(argv)-1])
	}
}
