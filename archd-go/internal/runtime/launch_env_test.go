package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNodeOptionsSurviveWindowsAndUnicodePaths(t *testing.T) {
	env := injectNodeEnv([]string{"NODE_OPTIONS=--max-old-space-size=4096"}, `C:\Users\José\Ambio\adapters\node`, 7745, "ws", `C:\work`)
	var opts string
	for _, kv := range env {
		if strings.HasPrefix(kv, "NODE_OPTIONS=") {
			opts = kv
		}
	}
	if !strings.Contains(opts, `--max-old-space-size=4096 --require "C:/Users/José/Ambio/adapters/node/cjs-bootstrap.cjs"`) {
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
	env := injectRubyEnv([]string{"RUBYOPT=-W0", "RUBYLIB=/opt/lib", "HOME=/h"}, `C:\Program Files\Ambio\resources\adapters\ruby`)
	got := map[string]string{}
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i > 0 {
			got[kv[:i]] = kv[i+1:]
		}
	}
	if got["RUBYOPT"] != "-rambio_recorder -W0" {
		t.Errorf("RUBYOPT names the feature, not a path, and keeps -W0: %q", got["RUBYOPT"])
	}
	if !strings.HasPrefix(got["RUBYLIB"], `C:\Program Files\Ambio\resources\adapters\ruby`) || !strings.HasSuffix(got["RUBYLIB"], "/opt/lib") {
		t.Errorf("RUBYLIB leads with the adapter folder and keeps the user's: %q", got["RUBYLIB"])
	}
	if got["HOME"] != "/h" {
		t.Errorf("other variables are untouched")
	}
}

// The JVM splits JAVA_TOOL_OPTIONS on spaces but honours quotes; the user's
// own options survive, and the notice the JVM prints about the variable is
// not the program's output.
func TestJavaAgentSurvivesSpacesAndExistingOptions(t *testing.T) {
	env := injectJavaEnv([]string{"JAVA_TOOL_OPTIONS=-Xmx2g", "HOME=/h"}, `C:\Program Files\Ambio\resources\adapters\java\ambio-agent.jar`)
	want := `JAVA_TOOL_OPTIONS=-javaagent:"C:\Program Files\Ambio\resources\adapters\java\ambio-agent.jar" -Xmx2g`
	if got := env[len(env)-1]; got != want || len(env) != 2 {
		t.Fatalf("env = %q, want last %q", env, want)
	}
	if got := injectJavaEnv(nil, "/opt/ambio/ambio-agent.jar"); got[0] != "JAVA_TOOL_OPTIONS=-javaagent:/opt/ambio/ambio-agent.jar" {
		t.Fatalf("a plain path needs no quotes: %q", got)
	}
	out := "Picked up JAVA_TOOL_OPTIONS: -javaagent:/x.jar\nBUILD OK\nPicked up JAVA_TOOL_OPTIONS: -javaagent:/x.jar\n27\n"
	if got := stripJavaToolOptionsNotice(out); got != "BUILD OK\n27\n" {
		t.Fatalf("stripped = %q", got)
	}
}

// MSBuild imports the targets file named by this variable into every project.
// A value the user set themselves is left alone, and the run says so.
func TestDotnetTargetsAreInjectedUnlessTheUserSetTheirOwn(t *testing.T) {
	env, note := injectDotnetEnv([]string{"HOME=/h", "MSBUILDDISABLENODEREUSE=0"}, `C:\Program Files\Ambio\adapters\dotnet\Ambio.targets`)
	joined := strings.Join(env, "\n")
	if note != "" || !strings.Contains(joined, `CustomAfterMicrosoftCommonTargets=C:\Program Files\Ambio\adapters\dotnet\Ambio.targets`) {
		t.Fatalf("env = %q, note = %q", env, note)
	}
	if !strings.Contains(joined, "MSBUILDDISABLENODEREUSE=1") || strings.Contains(joined, "MSBUILDDISABLENODEREUSE=0") {
		t.Fatalf("build servers must be off for the run: %q", env)
	}
	env, note = injectDotnetEnv([]string{"CustomAfterMicrosoftCommonTargets=/their/own.targets"}, "/ambio/Ambio.targets")
	if env != nil || !strings.Contains(note, "already set") {
		t.Fatalf("env = %q, note = %q", env, note)
	}
}

// PHP loads the recorder through an ini file of the run's own; the scan
// folder PHP was built with, and one the user set, stay in effect.
func TestPHPRecorderIsPrependedThroughARunIni(t *testing.T) {
	iniDir := filepath.Join(t.TempDir(), "php")
	sep := string(os.PathListSeparator)
	env, err := injectPHPEnv([]string{"HOME=/h"}, filepath.Join("opt", "Ambio Files", "adapters", "php"), iniDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := env[len(env)-1]; got != "PHP_INI_SCAN_DIR="+sep+iniDir {
		t.Fatalf("a leading separator keeps the built-in scan folder: %q", got)
	}
	ini, err := os.ReadFile(filepath.Join(iniDir, "ambio.ini"))
	if err != nil || !strings.Contains(string(ini), `auto_prepend_file="opt/Ambio Files/adapters/php/ambio_recorder.php"`) {
		t.Fatalf("ini = %q, err = %v", ini, err)
	}
	env, _ = injectPHPEnv([]string{"PHP_INI_SCAN_DIR=/etc/php/conf.d"}, "/a", iniDir)
	if got := env[len(env)-1]; got != "PHP_INI_SCAN_DIR=/etc/php/conf.d"+sep+iniDir {
		t.Fatalf("the user's own scan folder comes first: %q", got)
	}
}

// Cargo runs the wrapper named here for workspace crates only. One the user
// set themselves is left alone, and the run says so.
func TestRustWrapperIsArchdUnlessTheUserSetTheirOwn(t *testing.T) {
	env, note := injectRustEnv([]string{"HOME=/h"}, `C:\Program Files\Ambio\archd.exe`)
	joined := strings.Join(env, "\n")
	if note != "" || !strings.Contains(joined, `RUSTC_WORKSPACE_WRAPPER=C:\Program Files\Ambio\archd.exe`) || !strings.Contains(joined, "AMBIO_RUSTC_WRAPPER=1") {
		t.Fatalf("env = %q, note = %q", env, note)
	}
	env, note = injectRustEnv([]string{"RUSTC_WORKSPACE_WRAPPER=/usr/bin/sccache"}, "/ambio/archd")
	if env != nil || !strings.Contains(note, "already set") {
		t.Fatalf("env = %q, note = %q", env, note)
	}
}

// A command that compiles first gets time to build; anything else the usual minute.
func TestDefaultTimeoutAllowsBuilds(t *testing.T) {
	for command, want := range map[string]time.Duration{
		"cargo test": BuildRunTimeout,
		`"C:\\Program Files\\dotnet\\dotnet.exe" test`: BuildRunTimeout,
		"./mvnw -q test":                 BuildRunTimeout,
		"cd app && ./gradlew test":       BuildRunTimeout,
		"node repro.js":                  DefaultRunTimeout,
		"python -m pytest -k cargo_fees": DefaultRunTimeout,
	} {
		if got := defaultTimeout(command); got != want {
			t.Errorf("%s: %v, want %v", command, got, want)
		}
	}
}
