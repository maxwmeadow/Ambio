package runtime

import (
	"strings"
	"testing"
)

func TestNodeOptionsSurviveWindowsAndUnicodePaths(t *testing.T) {
	env := injectNodeEnv([]string{"NODE_OPTIONS=--max-old-space-size=4096"}, `C:\Users\José\Axiom\adapters\node`, 7745, "ws", `C:\work`)
	var opts string
	for _, kv := range env {
		if strings.HasPrefix(kv, "NODE_OPTIONS=") {
			opts = kv
		}
	}
	if !strings.Contains(opts, `--max-old-space-size=4096 --require "C:/Users/José/Axiom/adapters/node/cjs-bootstrap.cjs"`) {
		t.Fatalf("existing options must be kept and the path quoted with forward slashes and raw unicode: %s", opts)
	}
	if strings.Contains(opts, `\u`) || strings.Contains(opts, `\\`) {
		t.Fatalf("no escapes Node would misread: %s", opts)
	}
	if !strings.Contains(opts, `--import "file:///`) {
		t.Fatalf("esm bootstrap must be a file URL: %s", opts)
	}
}

func TestFileURL(t *testing.T) {
	for in, want := range map[string]string{
		"/Users/a b/x.mjs": "file:///Users/a%20b/x.mjs",
	} {
		if got := fileURL(in); got != want {
			t.Errorf("fileURL(%q) = %q, want %q", in, got, want)
		}
	}
}
