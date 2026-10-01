package runtime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Readiness says, per language in a project, what an investigation run can
// see there before anyone runs anything (docs/INVESTIGATION_RUNTIMES.md): full
// function-level evidence, exit code and output only, or nothing until the
// language's own toolchain is installed. Axiom never bundles that toolchain;
// it only says what is missing.
type LanguageReadiness struct {
	Language string `json:"language"` // display name
	Files    int    `json:"files"`
	// Level: "full" (a recorder loads through the runtime's own hook),
	// "output" (the command runs; exit code and output only) or "missing"
	// (the toolchain this language needs is not on PATH).
	Level   string `json:"level"`
	Tool    string `json:"tool,omitempty"`    // the command found, e.g. "python3"
	Version string `json:"version,omitempty"` // its first version line
	Note    string `json:"note"`              // what it means, and what would improve it
	Install string `json:"install,omitempty"` // the command that installs the toolchain here
}

type languageSpec struct {
	name        string
	tools       []string // first found wins
	versionArgs []string
	recorder    bool
	install     string // what installs the toolchain
	planned     string // when output-only: what is planned
}

// installCommand is the one command that installs a language's toolchain on
// this OS, where there is a well-known one (Homebrew, winget, apt).
var installCommand = map[string]map[string]string{
	"js":     {"darwin": "brew install node", "windows": "winget install OpenJS.NodeJS.LTS", "linux": "sudo apt install nodejs npm"},
	"python": {"darwin": "brew install python", "windows": "winget install Python.Python.3.12", "linux": "sudo apt install python3"},
	"ruby":   {"darwin": "brew install ruby", "windows": "winget install RubyInstallerTeam.RubyWithDevKit.3.3", "linux": "sudo apt install ruby"},
	"go":     {"darwin": "brew install go", "windows": "winget install GoLang.Go", "linux": "sudo apt install golang"},
	"java":   {"darwin": "brew install --cask temurin", "windows": "winget install EclipseAdoptium.Temurin.21.JDK", "linux": "sudo apt install openjdk-21-jdk"},
	"csharp": {"darwin": "brew install --cask dotnet-sdk", "windows": "winget install Microsoft.DotNet.SDK.8", "linux": "sudo apt install dotnet-sdk-8.0"},
	"rust":   {"darwin": "brew install rustup", "windows": "winget install Rustlang.Rustup", "linux": "curl https://sh.rustup.rs -sSf | sh"},
	"cpp":    {"darwin": "xcode-select --install", "windows": "winget install MSYS2.MSYS2", "linux": "sudo apt install build-essential"},
	"swift":  {"darwin": "xcode-select --install", "windows": "winget install Swift.Toolchain"},
	"php":    {"darwin": "brew install php", "linux": "sudo apt install php-cli"},
}

var readinessLanguages = map[string]languageSpec{
	"js":     {name: "JavaScript/TypeScript", tools: []string{"node"}, versionArgs: []string{"--version"}, recorder: true, install: "Node.js (nodejs.org)"},
	"python": {name: "Python", tools: []string{"python3", "python"}, versionArgs: []string{"--version"}, recorder: true, install: "Python (python.org)"},
	"ruby":   {name: "Ruby", tools: []string{"ruby"}, versionArgs: []string{"--version"}, recorder: true, install: "Ruby (ruby-lang.org)"},
	"go":     {name: "Go", tools: []string{"go"}, versionArgs: []string{"version"}, recorder: true, install: "Go (go.dev)"},
	"java":   {name: "JVM (Java, Kotlin, Scala, Groovy)", tools: []string{"java"}, versionArgs: []string{"-version"}, recorder: true, install: "a JDK (adoptium.net)"},
	"csharp": {name: "C#", tools: []string{"dotnet"}, versionArgs: []string{"--version"}, recorder: true, install: "the .NET SDK (dot.net)"},
	"rust":   {name: "Rust", tools: []string{"cargo"}, versionArgs: []string{"--version"}, install: "Rust (rustup.rs)", planned: "no function-level recorder for Rust yet"},
	"swift":  {name: "Swift", tools: []string{"swift"}, versionArgs: []string{"--version"}, install: "Swift (swift.org)", planned: "no function-level recorder for Swift yet"},
	"php":    {name: "PHP", tools: []string{"php"}, versionArgs: []string{"--version"}, recorder: true, install: "PHP (php.net)"},
	"cpp":    {name: "C/C++", tools: []string{"cc", "gcc", "clang", "cl"}, versionArgs: []string{"--version"}, install: "a C/C++ compiler", planned: "debug_runtime can attach gdb or lldb for function-level detail"},
}

// languageKey folds the indexer's language names into readiness families.
func languageKey(language string) string {
	switch strings.ToLower(language) {
	case "typescript", "tsx", "javascript", "jsx":
		return "js"
	case "python":
		return "python"
	case "ruby":
		return "ruby"
	case "go":
		return "go"
	case "java", "kotlin", "scala", "groovy":
		return "java" // one recorder: they all run on the JVM
	case "csharp":
		return "csharp"
	case "rust":
		return "rust"
	case "c", "cpp":
		return "cpp"
	case "swift":
		return "swift"
	case "php":
		return "php"
	}
	return ""
}

var (
	toolCacheMu sync.Mutex
	toolCache   = map[string]toolProbe{}
)

type toolProbe struct {
	path, version string
	at            time.Time
}

// probeTool finds a command on the user's PATH (the login shell's on macOS
// and Linux, as runs use) and reads its version line. Cached for a minute so
// a readout per case costs nothing.
func probeTool(name string, versionArgs []string) (string, string) {
	toolCacheMu.Lock()
	if hit, ok := toolCache[name]; ok && time.Since(hit.at) < time.Minute {
		toolCacheMu.Unlock()
		return hit.path, hit.version
	}
	toolCacheMu.Unlock()
	env := withUserPath(os.Environ())
	pathList := ""
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "PATH=") {
			pathList = kv[len("PATH="):]
		}
	}
	found := lookPathIn(name, pathList)
	version := ""
	if found != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, found, versionArgs...)
		cmd.Env = env
		out, _ := cmd.CombinedOutput()
		cancel()
		version = strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
		if len(version) > 80 {
			version = version[:80]
		}
	}
	toolCacheMu.Lock()
	toolCache[name] = toolProbe{path: found, version: version, at: time.Now()}
	toolCacheMu.Unlock()
	return found, version
}

func lookPathIn(name, pathList string) string {
	exts := []string{""}
	if goruntime.GOOS == "windows" {
		exts = []string{".exe", ".cmd", ".bat", ""}
	}
	for _, dir := range filepath.SplitList(pathList) {
		if dir == "" {
			continue
		}
		for _, ext := range exts {
			candidate := filepath.Join(dir, name+ext)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() && (goruntime.GOOS == "windows" || info.Mode()&0o111 != 0) {
				return candidate
			}
		}
	}
	return ""
}

// Readiness reports what runs can see for each language the project has, most
// files first. counts maps indexer language names to file counts.
func Readiness(counts map[string]int) []LanguageReadiness {
	return readiness(counts, probeTool)
}

func readiness(counts map[string]int, probe func(string, []string) (string, string)) []LanguageReadiness {
	byKey := map[string]int{}
	for language, n := range counts {
		if key := languageKey(language); key != "" {
			byKey[key] += n
		}
	}
	var out []LanguageReadiness
	for key, files := range byKey {
		spec := readinessLanguages[key]
		r := LanguageReadiness{Language: spec.name, Files: files}
		for _, tool := range spec.tools {
			if path, version := probe(tool, spec.versionArgs); path != "" {
				r.Tool, r.Version = tool, version
				break
			}
		}
		switch {
		case r.Tool == "":
			r.Level = "missing"
			r.Note = "no " + strings.Join(spec.tools, " or ") + " on PATH; runs of this code need " + spec.install
			if cmd := installCommand[key][goruntime.GOOS]; cmd != "" {
				r.Install = cmd
				r.Note += " - install with `" + cmd + "`"
			}
		case spec.recorder:
			r.Level = "full"
			r.Note = "runs record calls, arguments, returns and crashes; nothing to install"
		default:
			r.Level = "output"
			r.Note = "runs show exit code and output; " + spec.planned
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Files != out[j].Files {
			return out[i].Files > out[j].Files
		}
		return out[i].Language < out[j].Language
	})
	return out
}
