package runtime

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A server under observation, exercised by a separate command: the server's
// function is recorded, the server is stopped afterwards, and its output is
// kept apart from the command's.
func TestRunAgainstAServerRecordsTheServer(t *testing.T) {
	root := serverWorkspace(t)
	port := freePort(t)
	writeFile(t, filepath.Join(root, "server.py"), `
import http.server, sys

def price(qty):
    return qty * 3

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = str(price(int(self.path.strip("/") or 1))).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

print("listening", flush=True)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
`)
	// A script, not python -c "...": cmd.exe on Windows mangles the quoting.
	writeFile(t, filepath.Join(root, "client.py"), "import sys, urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:%s/4' % sys.argv[1]).read().decode())\n")
	m := &Manager{}
	out, err := m.RunExperiment(context.Background(), RunSpec{
		Root:    root,
		Command: fmt.Sprintf("%s client.py %d", testPython(), port),
		Server:  fmt.Sprintf("%s server.py %d", testPython(), port),
		Port:    port,
		Watches: []RunWatch{{AbsPath: filepath.Join(root, "server.py"), Symbol: "price"}},
		Timeout: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Server == nil || out.Server.Failed != "" || out.Server.Exited {
		t.Fatalf("server: %+v", out.Server)
	}
	if strings.TrimSpace(out.Output) != "12" {
		t.Fatalf("command output %q", out.Output)
	}
	if !strings.Contains(out.Server.Output, "listening") || strings.Contains(out.Output, "listening") {
		t.Fatalf("outputs mixed: command %q, server %q", out.Output, out.Server.Output)
	}
	var calls int64
	for _, w := range out.Watched {
		if w.Symbol == "price" {
			calls = w.Calls
		}
	}
	if calls != 1 {
		t.Fatalf("price recorded %d calls in the server; watched %+v", calls, out.Watched)
	}
	if listening(port) {
		t.Fatal("the server is still running after the run")
	}
}

// A server that dies while starting: the command never runs, and why is the
// result.
func TestRunAgainstAServerThatNeverStarts(t *testing.T) {
	root := serverWorkspace(t)
	port := freePort(t)
	writeFile(t, filepath.Join(root, "server.py"), "raise SystemExit('missing DATABASE_URL')\n")
	m := &Manager{}
	out, err := m.RunExperiment(context.Background(), RunSpec{
		Root:    root,
		Command: "echo should-not-run",
		Server:  testPython() + " server.py",
		Port:    port,
		Timeout: 20 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Server == nil || !strings.Contains(out.Server.Failed, "exited with code 1") {
		t.Fatalf("server: %+v", out.Server)
	}
	if strings.Contains(out.Output, "should-not-run") {
		t.Fatal("the command ran although the server never started")
	}
	if !strings.Contains(out.Server.Output, "missing DATABASE_URL") {
		t.Fatalf("server output %q", out.Server.Output)
	}
}

// A port someone else already holds would send the command to the wrong
// process.
func TestRunAgainstAServerRefusesABusyPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	m := &Manager{}
	_, err = m.RunExperiment(context.Background(), RunSpec{
		Root:    t.TempDir(),
		Command: "echo hi",
		Server:  "sleep 30",
		Port:    port,
	})
	if err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("err = %v", err)
	}
}

func serverWorkspace(t *testing.T) string {
	t.Helper()
	if testPython() == "" {
		t.Skip("python not installed")
	}
	adapters, err := filepath.Abs(filepath.Join("..", "..", "..", "adapters"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMBIO_ADAPTERS_DIR", adapters)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// testPython is a Python that runs: on Windows "python3" can be the Microsoft
// Store placeholder, which exists on PATH but only prints an install hint.
func testPython() string {
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil && exec.Command(path, "--version").Run() == nil {
			return name
		}
	}
	return ""
}
