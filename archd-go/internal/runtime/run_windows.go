//go:build windows

package runtime

import (
	"os/exec"
	"strconv"
	"syscall"
)

// CREATE_NEW_PROCESS_GROUP keeps a run's console signals away from archd.
func prepareProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP
}

// windowsShell runs line through cmd.exe exactly as written. Go quotes each
// argument for CommandLineToArgvW, which turns a " in the line into \" - and
// cmd.exe does not read that, so `"C:\Program Files\...\javac" x` failed
// as an unknown command. /S /C "line" hands cmd the line untouched.
func windowsShell(line string) *exec.Cmd {
	cmd := exec.Command("cmd")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd /S /C "` + line + `"`}
	return cmd
}

// Windows has no process-group kill; taskkill /T walks the child tree, which
// matters because the command runs under cmd.exe (cmd -> npm -> node).
func killProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd.Process == nil {
		return
	}
	args := []string{"/T", "/PID", strconv.Itoa(cmd.Process.Pid)}
	if force {
		args = append([]string{"/F"}, args...)
	}
	if exec.Command("taskkill", args...).Run() == nil && !force {
		return
	}
	// A console process cannot be asked to close, so a gentle taskkill fails.
	// Kill the whole tree while its root is still alive: killing only cmd.exe
	// orphans the child, which keeps the output pipe open and leaves the run
	// waiting for it forever.
	if !force {
		killProcessGroup(cmd, true)
		return
	}
	_ = cmd.Process.Kill()
}
