package infradetect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"sort"
	"strings"
)

// ConfigNames are the project files detection reads, by file name, in any
// folder of the project (a monorepo keeps them per service). Workflow files
// are matched by directory, SQL files and ORM schemas by extension.
var ConfigNames = map[string]bool{
	"package.json": true, "requirements.txt": true, "pyproject.toml": true, "go.mod": true,
	".env.example": true, ".env.sample": true, ".env.template": true, ".env": true, ".env.local": true, ".env.development": true,
	"docker-compose.yml": true, "docker-compose.yaml": true, "compose.yml": true, "compose.yaml": true,
	"vercel.json": true, "fly.toml": true, "netlify.toml": true, "render.yaml": true, "railway.json": true, "railway.toml": true,
	"Dockerfile": true, "Procfile": true,
	"pom.xml": true, "build.gradle": true, "build.gradle.kts": true, "Gemfile": true, "Cargo.toml": true,
	"database.yml": true, "application.properties": true, "application.yml": true, "application.yaml": true,
	"appsettings.json": true, "appsettings.Development.json": true,
}

// WantsConfig reports whether detection reads a file at this relative path.
func WantsConfig(relPath string) bool {
	name := path.Base(relPath)
	if ConfigNames[name] || strings.HasPrefix(name, "Dockerfile.") || strings.HasSuffix(name, ".csproj") {
		return true
	}
	if strings.HasSuffix(name, ".sql") || name == "schema.prisma" {
		return true
	}
	dir := path.Dir(relPath)
	ext := path.Ext(relPath)
	return dir == ".github/workflows" && (ext == ".yml" || ext == ".yaml")
}

// configFiles lists the loaded config files with one of these names, root
// first, then by path.
func (d *detection) configFiles(names ...string) []string {
	want := map[string]bool{}
	for _, name := range names {
		want[name] = true
	}
	var out []string
	for file := range d.in.Config {
		if want[path.Base(file)] {
			out = append(out, file)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		di, dj := strings.Count(out[i], "/"), strings.Count(out[j], "/")
		if di != dj {
			return di < dj
		}
		return out[i] < out[j]
	})
	return out
}

var envLine = regexp.MustCompile(`^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=`)

// readEnvFiles records declared variable names. Only names are read: the part
// after "=" is never looked at, let alone stored.
func (d *detection) readEnvFiles() {
	examples := []string{".env.example", ".env.sample", ".env.template"}
	locals := []string{".env", ".env.local", ".env.development"}
	scan := func(file string, into func(name string, line int)) {
		body, ok := d.in.Config[file]
		if !ok {
			return
		}
		scanner := bufio.NewScanner(bytes.NewReader(body))
		line := 0
		for scanner.Scan() {
			line++
			if m := envLine.FindStringSubmatch(scanner.Text()); m != nil {
				into(m[1], line)
			}
		}
	}
	for _, file := range d.configFiles(examples...) {
		scan(file, func(name string, line int) {
			if _, seen := d.envDeclared[name]; !seen {
				d.envDeclared[name] = ref(file, line)
			}
		})
	}
	for _, file := range d.configFiles(locals...) {
		scan(file, func(name string, line int) { d.envPresent[name] = true })
	}
}

// readManifests proposes services a manifest declares that no file loads -
// low-confidence, labelled declared-only so the canvas can say so.
func (d *detection) readManifests() {
	type declaration struct{ pkg, file string }
	declared := map[string][]declaration{} // family → packages, with the manifest naming them
	for _, file := range d.configFiles("package.json") {
		var manifest struct {
			Dependencies map[string]string `json:"dependencies"`
		}
		if json.Unmarshal(d.in.Config[file], &manifest) == nil {
			for name := range manifest.Dependencies {
				declared["js"] = append(declared["js"], declaration{name, file})
			}
		}
	}
	for _, file := range d.configFiles("requirements.txt") {
		for _, raw := range strings.Split(string(d.in.Config[file]), "\n") {
			name := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
			name = requirementName.ReplaceAllString(name, "")
			if name != "" {
				declared["py"] = append(declared["py"], declaration{name, file})
			}
		}
	}
	for _, file := range d.configFiles("go.mod") {
		for _, raw := range strings.Split(string(d.in.Config[file]), "\n") {
			fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(raw), "require "))
			if len(fields) >= 2 && strings.Contains(fields[0], ".") && !strings.HasPrefix(fields[0], "module") {
				declared["go"] = append(declared["go"], declaration{fields[0], file})
			}
		}
	}
	for _, file := range d.configFiles("pom.xml") {
		for _, m := range pomDependency.FindAllSubmatch(d.in.Config[file], -1) {
			declared["java"] = append(declared["java"], declaration{string(m[1]), file})
		}
	}
	for _, file := range d.configFiles("build.gradle", "build.gradle.kts") {
		for _, m := range gradleDependency.FindAllSubmatch(d.in.Config[file], -1) {
			declared["java"] = append(declared["java"], declaration{string(m[1]), file})
		}
	}
	for file := range d.in.Config {
		if strings.HasSuffix(file, ".csproj") {
			for _, m := range nugetReference.FindAllSubmatch(d.in.Config[file], -1) {
				declared["cs"] = append(declared["cs"], declaration{string(m[1]), file})
			}
		}
	}
	for _, file := range d.configFiles("Gemfile") {
		for _, m := range gemLine.FindAllSubmatch(d.in.Config[file], -1) {
			declared["rb"] = append(declared["rb"], declaration{string(m[1]), file})
		}
	}
	for _, file := range d.configFiles("Cargo.toml") {
		inDeps := false
		for _, raw := range strings.Split(string(d.in.Config[file]), "\n") {
			line := strings.TrimSpace(raw)
			if strings.HasPrefix(line, "[") {
				inDeps = strings.Contains(line, "dependencies")
				continue
			}
			if m := cargoDependency.FindStringSubmatch(line); inDeps && m != nil {
				declared["rs"] = append(declared["rs"], declaration{strings.ReplaceAll(m[1], "-", "_"), file})
			}
		}
	}
	for family, packages := range declared {
		sort.Slice(packages, func(i, j int) bool { return packages[i].pkg+packages[i].file < packages[j].pkg+packages[j].file })
		for _, decl := range packages {
			candidates := d.servicesForPackage(family, decl.pkg)
			if len(candidates) != 1 {
				continue
			}
			service := candidates[0]
			existing, loaded := d.proposals[service.ID]
			if loaded && (len(existing.Edges) > 0 || !existing.DeclaredOnly) {
				existing.Evidence = append(existing.Evidence, Evidence{Signal: "package", Ref: decl.file, Detail: decl.pkg})
				continue
			}
			p := d.proposal(service)
			p.DeclaredOnly = true
			p.Evidence = append(p.Evidence, Evidence{Signal: "package", Ref: decl.file, Detail: decl.pkg + " (declared, not loaded by any file)"})
		}
	}
}

var (
	pomDependency    = regexp.MustCompile(`(?s)<dependency>\s*<groupId>([^<]+)</groupId>`)
	gradleDependency = regexp.MustCompile(`(?m)^\s*(?:implementation|api|compile|runtimeOnly)\s*\(?\s*['"]([\w.-]+):`)
	nugetReference   = regexp.MustCompile(`<PackageReference\s+Include="([^"]+)"`)
	gemLine          = regexp.MustCompile(`(?m)^\s*gem\s+['"]([\w.-]+)['"]`)
	cargoDependency  = regexp.MustCompile(`^([A-Za-z0-9_-]+)\s*=`)
)

var requirementName = regexp.MustCompile(`[<>=!~\[; ].*$`)

// Compose images and what they stand in for locally. A service entry names a
// registry id; a category entry attaches to whichever node fills that role.
var composeImages = []struct {
	pattern  *regexp.Regexp
	service  string
	category string
	kind     string
}{
	{regexp.MustCompile(`(^|/)(postgres|postgis|postgresql)$`), "postgresql/postgres", "", "local-service"},
	{regexp.MustCompile(`(^|/)(mysql|mariadb)$`), "mysql/mysql", "", "local-service"},
	{regexp.MustCompile(`(^|/)mongo(db)?$`), "mongodb/mongodb", "", "local-service"},
	{regexp.MustCompile(`(^|/)(redis|valkey|redis-stack)$`), "redis/redis", "", "local-service"},
	{regexp.MustCompile(`(^|/)minio$`), "aws/s3", "", "emulator"},
	{regexp.MustCompile(`(^|/)localstack$`), "aws/s3", "", "emulator"},
	{regexp.MustCompile(`(^|/)stripe-mock$`), "stripe/api", "", "emulator"},
	{regexp.MustCompile(`(^|/)(mailpit|mailhog|maildev)$`), "", "email", "emulator"},
	{regexp.MustCompile(`(^|/)elasticsearch$`), "elastic/elasticsearch", "", "local-service"},
	{regexp.MustCompile(`(^|/)meilisearch$`), "meilisearch/meilisearch", "", "local-service"},
	{regexp.MustCompile(`(^|/)rabbitmq$`), "rabbitmq/rabbitmq", "", "local-service"},
	{regexp.MustCompile(`(^|/)(cp-kafka|kafka)$`), "apache/kafka", "", "local-service"},
	{regexp.MustCompile(`(^|/)clickhouse(-server)?$`), "clickhouse/clickhouse", "", "local-service"},
}

type composeService struct {
	name  string
	image string
	line  int
}

// parseCompose reads service names and images from a compose file. It is an
// indentation scanner, not a YAML parser: compose files are regular enough,
// and archd takes no YAML dependency for two fields.
func parseCompose(body []byte) []composeService {
	var out []composeService
	scanner := bufio.NewScanner(bytes.NewReader(body))
	inServices := false
	serviceIndent := -1
	line := 0
	var current *composeService
	for scanner.Scan() {
		line++
		text := scanner.Text()
		trimmed := strings.TrimSpace(text)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(text) - len(strings.TrimLeft(text, " "))
		if indent == 0 {
			inServices = trimmed == "services:"
			serviceIndent = -1
			continue
		}
		if !inServices {
			continue
		}
		if serviceIndent < 0 {
			serviceIndent = indent
		}
		if indent == serviceIndent && strings.HasSuffix(trimmed, ":") {
			out = append(out, composeService{name: strings.TrimSuffix(trimmed, ":"), line: line})
			current = &out[len(out)-1]
			continue
		}
		if current != nil && indent > serviceIndent && strings.HasPrefix(trimmed, "image:") {
			image := strings.Trim(strings.TrimSpace(strings.TrimPrefix(trimmed, "image:")), `"'`)
			if at := strings.LastIndex(image, ":"); at > strings.LastIndex(image, "/") {
				image = image[:at]
			}
			current.image = image
			current.line = line
		}
	}
	return out
}

// readConfig reads compose, platform and CI files.
func (d *detection) readConfig() {
	for _, file := range d.configFiles("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml") {
		body := d.in.Config[file]
		for _, svc := range parseCompose(body) {
			if svc.image == "" {
				continue
			}
			for _, known := range composeImages {
				if !known.pattern.MatchString(svc.image) {
					continue
				}
				impl := Implementation{Environment: "local", Kind: known.kind, Ref: "compose:" + svc.name,
					Evidence: ref(file, svc.line), Source: "parser"}
				if known.service != "" {
					if s, ok := d.in.Registry.Get(known.service); ok {
						p := d.proposal(s)
						p.Implementations = append(p.Implementations, impl)
						p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: ref(file, svc.line), Detail: "image " + svc.image})
					}
				} else {
					for _, p := range d.proposals {
						if p.Category == known.category {
							p.Implementations = append(p.Implementations, impl)
						}
					}
				}
				break
			}
		}
	}
	d.readVercel()
	d.readWorkflows()
	d.readAppConfig()
	d.readHosting()
}

func (d *detection) readVercel() {
	body, ok := d.in.Config["vercel.json"]
	if !ok {
		return
	}
	var config struct {
		Functions map[string]json.RawMessage `json:"functions"`
		Crons     []struct {
			Path     string `json:"path"`
			Schedule string `json:"schedule"`
		} `json:"crons"`
	}
	_ = json.Unmarshal(body, &config)
	if s, ok := d.in.Registry.Get("vercel/platform"); ok {
		p := d.proposal(s)
		p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: "vercel.json"})
		for entry := range config.Functions {
			for _, f := range d.in.Files {
				if f.RelPath == entry || matchGlob(entry, f.RelPath) {
					line := lineAt(body, bytes.Index(body, []byte(`"`+entry+`"`)))
					p.Edges = append(p.Edges, Edge{FileID: f.ID, Kind: "RUNS_ON", Evidence: ref("vercel.json", line)})
				}
			}
		}
	}
	if len(config.Crons) == 0 {
		return
	}
	s, ok := d.in.Registry.Get("vercel/cron")
	if !ok {
		return
	}
	p := d.proposal(s)
	p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: "vercel.json", Detail: "crons"})
	for _, cron := range config.Crons {
		line := lineAt(body, bytes.Index(body, []byte(`"`+cron.Path+`"`)))
		p.Contents = append(p.Contents, Content{Kind: "schedule", Name: cron.Path,
			Detail: map[string]any{"cron": cron.Schedule, "route": cron.Path}, Evidence: ref("vercel.json", line)})
		// The route handler is the job: the file that declares the cron path.
		for relPath, source := range d.in.Sources {
			if at := bytes.Index(source, []byte(`'`+cron.Path+`'`)); at >= 0 || bytes.Contains(source, []byte(`"`+cron.Path+`"`)) {
				if at < 0 {
					at = bytes.Index(source, []byte(`"`+cron.Path+`"`))
				}
				if id := d.fileID(relPath); id != "" {
					p.Edges = append(p.Edges, Edge{FileID: id, Kind: "SCHEDULED_BY", Evidence: ref(relPath, lineAt(source, at))})
				}
			}
		}
	}
	sortProposal(p)
}

func (d *detection) fileID(relPath string) string {
	for _, f := range d.in.Files {
		if f.RelPath == relPath {
			return f.ID
		}
	}
	return ""
}

// matchGlob supports the "**" and "*" patterns platform configs use for
// function entries ("api/**/*.ts").
func matchGlob(pattern, relPath string) bool {
	if !strings.Contains(pattern, "*") {
		return false
	}
	re := regexp.QuoteMeta(pattern)
	re = strings.ReplaceAll(re, `\*\*/`, `(.*/)?`)
	re = strings.ReplaceAll(re, `\*\*`, `.*`)
	re = strings.ReplaceAll(re, `\*`, `[^/]*`)
	ok, _ := regexp.MatchString("^"+re+"$", relPath)
	return ok
}

var workflowCron = regexp.MustCompile(`cron:\s*['"]([^'"]+)['"]`)

func (d *detection) readWorkflows() {
	s, ok := d.in.Registry.Get("github/actions-schedule")
	if !ok {
		return
	}
	var files []string
	for file := range d.in.Config {
		if path.Dir(file) == ".github/workflows" {
			files = append(files, file)
		}
	}
	sort.Strings(files)
	for _, file := range files {
		body := d.in.Config[file]
		if !bytes.Contains(body, []byte("schedule:")) {
			continue
		}
		for _, match := range workflowCron.FindAllSubmatchIndex(body, -1) {
			p := d.proposal(s)
			expr := string(body[match[2]:match[3]])
			p.Contents = append(p.Contents, Content{Kind: "schedule", Name: path.Base(file) + " " + expr,
				Detail: map[string]any{"cron": expr, "workflow": file}, Evidence: ref(file, lineAt(body, match[0]))})
			p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: ref(file, lineAt(body, match[0]))})
		}
		// What the scheduled workflow runs: `python -m pkg.module`, `node
		// scripts/x.js`, `go run ./cmd/x`, `npm run <script>` is left alone.
		for _, m := range workflowRun.FindAllSubmatchIndex(body, -1) {
			target := ""
			for g := 2; g+1 < len(m); g += 2 {
				if m[g] >= 0 {
					target = string(body[m[g]:m[g+1]])
					break
				}
			}
			if fileID := d.fileForRunTarget(target); fileID != "" {
				p := d.proposal(s)
				p.Edges = append(p.Edges, Edge{FileID: fileID, Kind: "SCHEDULED_BY",
					Evidence: ref(file, lineAt(body, m[0])) + " (runs " + target + ")"})
			}
		}
	}
}

var workflowRun = regexp.MustCompile(`(?:python3?\s+-m\s+([\w.]+)|(?:python3?|node|tsx|ts-node|bun|deno\s+run)\s+([\w./-]+\.(?:py|js|mjs|ts))|go\s+run\s+(\./[\w./-]+))`)

var scriptExt = map[string]bool{".py": true, ".js": true, ".mjs": true, ".ts": true}

// fileForRunTarget finds the project file a command runs: a dotted Python
// module, a script path, or a Go package folder (its main.go).
func (d *detection) fileForRunTarget(target string) string {
	var suffixes []string
	switch {
	case strings.HasPrefix(target, "./"):
		dir := strings.TrimPrefix(target, "./")
		suffixes = []string{dir + "/main.go"}
	case strings.Contains(target, "/") || scriptExt[path.Ext(target)]:
		suffixes = []string{strings.TrimPrefix(target, "./")}
	default:
		module := strings.ReplaceAll(target, ".", "/")
		suffixes = []string{module + ".py", module + "/__main__.py"}
	}
	best := ""
	for id, f := range d.files {
		for _, suffix := range suffixes {
			if f.RelPath == suffix || strings.HasSuffix(f.RelPath, "/"+suffix) {
				if best == "" || f.RelPath < d.files[best].RelPath {
					best = id
				}
			}
		}
	}
	return best
}

// collectRequirements ties every env name to the role whose registry patterns
// claim it. Among several claimants the one detected from code wins; names no
// role claims are still requirements, just not a node's.
func (d *detection) collectRequirements() {
	for _, name := range d.envNames() {
		req := Requirement{Name: name, Present: d.envPresent[name]}
		if reads := d.envByName[name]; len(reads) > 0 {
			req.Evidence = ref(d.files[reads[0].FileID].RelPath, reads[0].Line)
		} else {
			req.Evidence = d.envDeclared[name]
		}
		type claimant struct {
			p        *Proposal
			strength int
			reader   bool // a file reading the variable is one of the service's own
		}
		readers := map[string]bool{}
		for _, read := range d.envByName[name] {
			readers[read.FileID] = true
		}
		var claimants []claimant
		ids := make([]string, 0, len(d.proposals))
		for id := range d.proposals {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			p := d.proposals[id]
			s, ok := d.in.Registry.Get(p.Service)
			if !ok || p.Instance != "" {
				continue
			}
			strength := envMatchStrength(s, name)
			if strength == 0 {
				continue
			}
			c := claimant{p: p, strength: strength}
			for _, e := range p.Edges {
				c.reader = c.reader || readers[e.FileID]
			}
			claimants = append(claimants, c)
		}
		if len(claimants) > 0 {
			sort.SliceStable(claimants, func(i, j int) bool {
				a, b := claimants[i], claimants[j]
				if a.reader != b.reader {
					return a.reader
				}
				if a.strength != b.strength {
					return a.strength > b.strength
				}
				loadedA, loadedB := len(a.p.Edges) > 0, len(b.p.Edges) > 0
				if loadedA != loadedB {
					return loadedA
				}
				return rolePriority(a.p) < rolePriority(b.p)
			})
			req.Service = claimants[0].p.Service
		}
		d.requirement = append(d.requirement, req)
	}
}

// rolePriority breaks ties for a shared variable (REDIS_URL serves both the
// cache and a Redis-backed queue): the store it names outranks what runs on it.
func rolePriority(p *Proposal) int {
	switch p.Category {
	case "database", "cache", "storage", "search":
		return 0
	case "queue":
		return 1
	}
	return 2
}
