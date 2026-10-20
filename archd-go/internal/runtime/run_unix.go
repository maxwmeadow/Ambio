//go:build !windows

package runtime

import (
	"os/exec"
	"syscall"
)

// A run's command is usually a wrapper (sh -> npm -> node). Killing only the
// shell would orphan the program being debugged, so the whole run gets its own
// process group and a timeout signals the group.
func prepareProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// windowsShell is Windows-only; shellCommand never calls it elsewhere.
func windowsShell(line string) *exec.Cmd { return exec.Command("cmd", "/C", line) }

func killProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}
