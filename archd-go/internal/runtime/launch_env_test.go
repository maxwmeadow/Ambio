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

// A path inside RUBYOPT is split on spaces, so the adapter folder goes on
// RUBYLIB and RUBYOPT names only the feature; the user's own values survive.
func TestRubyRecorderSurvivesSpacesAndExistingOptions(t *testing.T) {
	env := injectRubyEnv([]string{"RUBYOPT=-W0", "RUBYLIB=/opt/lib", "HOME=/h"}, `C:\Program Files\Axiom\resources\adapters\ruby`)
	got := map[string]string{}
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i > 0 {
			got[kv[:i]] = kv[i+1:]
		}
	}
	if got["RUBYOPT"] != "-raxiom_recorder -W0" {
		t.Errorf("RUBYOPT names the feature, not a path, and keeps -W0: %q", got["RUBYOPT"])
	}
	if !strings.HasPrefix(got["RUBYLIB"], `C:\Program Files\Axiom\resources\adapters\ruby`) || !strings.HasSuffix(got["RUBYLIB"], "/opt/lib") {
		t.Errorf("RUBYLIB leads with the adapter folder and keeps the user's: %q", got["RUBYLIB"])
	}
	if got["HOME"] != "/h" {
		t.Errorf("other variables are untouched")
	}
}
