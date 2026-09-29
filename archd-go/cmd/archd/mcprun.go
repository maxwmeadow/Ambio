package main

import (
	"fmt"
	"os"
)

// mcpRunCommand is the subcommand agent configs invoke to start Axiom's MCP
// server:
//
//	archd mcp-run <runtime> <script> [args...]
//
// <runtime> is the Axiom application executable itself. Electron runs as a
// plain Node process when ELECTRON_RUN_AS_NODE=1, so Axiom ships its own Node
// and users never install one. That variable has to be set by whoever starts
// the process, and every agent host spells environment configuration
// differently (JSON, TOML, XML) - some not at all. This launcher sets it
// once, here, so every host only needs a command and arguments.
const mcpRunCommand = "mcp-run"

func mcpRunEnv() []string {
	return append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
}

func runMCP(args []string) {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: archd mcp-run <runtime> <script> [args...]")
		os.Exit(2)
	}
	runtimePath := args[0]
	if _, err := os.Stat(runtimePath); err != nil {
		fmt.Fprintf(os.Stderr, "Axiom's MCP server could not start: the Axiom app was not found at %s. "+
			"Reinstall Axiom, or open it and use Connect an Agent to repair this agent's configuration.\n", runtimePath)
		os.Exit(1)
	}
	os.Exit(execRuntime(runtimePath, args[1:]))
}
