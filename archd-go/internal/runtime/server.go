package runtime

// Runs against a long-running process. Most real bugs live behind a server: a
// request comes back 500, a webhook double-charges. `run` with Server starts
// that server under the same recorders as the command, waits until it takes
// connections, runs the command (the probe: curl, a client script, a test
// against it), then gives every recorder time to flush and stops the server.
// Evidence from both processes merges into one run.

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"time"
)

const (
	// With no port to watch, how long a server gets to start.
	serverSettle = 2 * time.Second
	// Every recorder flushes at least once a second; a server is stopped by a
	// signal, so what it recorded after its last flush would be lost.
	serverFlush = 1200 * time.Millisecond
	readyPoll   = 100 * time.Millisecond
)

// ServerOutcome is what the server did during a run.
type ServerOutcome struct {
	Command string `json:"command"`
	Port    int    `json:"port,omitempty"`
	ReadyMs int64  `json:"readyMs"`
	// Failed says why the command never ran (the server died, or never
	// listened). Empty when the command ran.
	Failed string `json:"failed,omitempty"`
	// Exited is set when the server ended on its own instead of being
	// stopped after the command: a crash mid-request.
	Exited          bool   `json:"exited,omitempty"`
	ExitCode        int    `json:"exitCode,omitempty"`
	Output          string `json:"output"`
	OutputBytes     int64  `json:"outputBytes"`
	OutputTruncated bool   `json:"outputTruncated"`
}

type serverProcess struct {
	cmd     *exec.Cmd
	out     *cappedOutput
	exited  chan struct{} // closed once the process has been waited for
	waitErr error
	started time.Time
}

func startServer(line, cwd string, env []string) (*serverProcess, error) {
	cmd := shellCommand(line)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdin = nil
	out := &cappedOutput{}
	cmd.Stdout = out
	cmd.Stderr = out
	prepareProcessGroup(cmd)
	// A child that outlives the server must not hold the run open through
	// its output pipe.
	cmd.WaitDelay = killGrace
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start server %q: %w", line, err)
	}
	s := &serverProcess{cmd: cmd, out: out, exited: make(chan struct{}), started: time.Now()}
	go func() {
		s.waitErr = cmd.Wait()
		close(s.exited)
	}()
	return s, nil
}

// waitReady returns "" once the server can take the command, or why it
// cannot.
func (s *serverProcess) waitReady(ctx context.Context, port int) string {
	settle := time.After(serverSettle)
	var poll <-chan time.Time
	if port > 0 {
		ticker := time.NewTicker(readyPoll)
		defer ticker.Stop()
		poll = ticker.C
		settle = nil
	}
	for {
		select {
		case <-s.exited:
			return fmt.Sprintf("the server exited with code %d before it was ready", exitCodeOf(s.waitErr))
		case <-ctx.Done():
			if port > 0 {
				return fmt.Sprintf("nothing accepted connections on port %d within the run's time limit", port)
			}
			return "the run's time limit passed while the server was starting"
		case <-settle:
			return ""
		case <-poll:
			if listening(port) {
				return ""
			}
		}
	}
}

// stop lets the recorders flush, then ends the server's process group. It
// reports whether the server had already exited on its own, and how.
func (s *serverProcess) stop() (exited bool, code int) {
	select {
	case <-s.exited:
		return true, exitCodeOf(s.waitErr)
	case <-time.After(serverFlush):
	}
	killProcessGroup(s.cmd, false)
	select {
	case <-s.exited:
	case <-time.After(killGrace):
		killProcessGroup(s.cmd, true)
		<-s.exited
	}
	return false, 0
}

// listening reports whether something on this machine accepts connections on
// port, over IPv4 or IPv6 ("localhost" binds ::1 alone on some systems).
func listening(port int) bool {
	for _, host := range []string{"127.0.0.1", "::1"} {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
	}
	return false
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return -1
}

// finishServer stops the server and records how it ended and what it printed.
func finishServer(s *serverProcess, out *ServerOutcome) {
	out.Exited, out.ExitCode = s.stop()
	out.Output, out.OutputTruncated = s.out.String()
	out.OutputBytes = s.out.total
}
