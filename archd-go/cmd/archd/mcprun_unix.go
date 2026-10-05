//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

// execRuntime replaces this process with the runtime, so the agent talks to
// the MCP server directly over the same stdio and signals reach it unchanged.
func execRuntime(runtimePath string, args []string) int {
	argv := append([]string{runtimePath}, args...)
	err := syscall.Exec(runtimePath, argv, mcpRunEnv())
	fmt.Fprintf(os.Stderr, "Ambio's MCP server could not start: %v\n", err)
	return 1
}
