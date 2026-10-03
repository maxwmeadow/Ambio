//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

// Windows has no exec(2); run the runtime as a child that inherits stdio and
// exit with its code.
func execRuntime(runtimePath string, args []string) int {
	cmd := exec.Command(runtimePath, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = mcpRunEnv()
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "Ambio's MCP server could not start: %v\n", err)
		return 1
	}
	return 0
}
