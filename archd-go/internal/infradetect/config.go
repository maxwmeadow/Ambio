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

// ConfigPaths are the project files detection reads, relative to the root.
// Workflow files are matched by directory in WantsConfig.
var ConfigPaths = []string{
	"package.json", "requirements.txt", "pyproject.toml", "go.mod",
	".env.example", ".env.sample", ".env.template", ".env", ".env.local", ".env.development",
	"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
	"vercel.json", "fly.toml", "netlify.toml", "render.yaml", "railway.json", "railway.toml",
	"Dockerfile", "Procfile",
}

// WantsConfig reports whether detection reads a file at this relative path.
func WantsConfig(relPath string) bool {
	for _, p := range ConfigPaths {
		if relPath == p {
			return true
		}
	}
	dir := path.Dir(relPath)
	ext := path.Ext(relPath)
	return dir == ".github/workflows" && (ext == ".yml" || ext == ".yaml")
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
	for _, file := range examples {
		scan(file, func(name string, line int) {
			if _, seen := d.envDeclared[name]; !seen {
				d.envDeclared[name] = ref(file, line)
			}
		})
	}
	for _, file := range locals {
		scan(file, func(name string, line int) { d.envPresent[name] = true })
	}
}

// readManifests proposes services a manifest declares that no file loads -
// low-confidence, labelled declared-only so the canvas can say so.
func (d *detection) readManifests() {
	declared := map[string][]string{} // family → packages
	if body, ok := d.in.Config["package.json"]; ok {
		var manifest struct {
			Dependencies    map[string]string `json:"dependencies"`
			DevDependencies map[string]string `json:"devDependencies"`
		}
		if json.Unmarshal(body, &manifest) == nil {
			for name := range manifest.Dependencies {
				declared["js"] = append(declared["js"], name)
			}
		}
	}
	if body, ok := d.in.Config["requirements.txt"]; ok {
		for _, raw := range strings.Split(string(body), "\n") {
			name := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
			name = regexp.MustCompile(`[<>=!~\[; ].*$`).ReplaceAllString(name, "")
			if name != "" {
				declared["py"] = append(declared["py"], name)
			}
		}
	}
	if body, ok := d.in.Config["go.mod"]; ok {
		for _, raw := range strings.Split(string(body), "\n") {
			fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(raw), "require "))
			if len(fields) >= 2 && strings.Contains(fields[0], ".") && !strings.HasPrefix(fields[0], "module") {
				declared["go"] = append(declared["go"], fields[0])
			}
		}
	}
	manifestFor := map[string]string{"js": "package.json", "py": "requirements.txt", "go": "go.mod"}
	for family, packages := range declared {
		sort.Strings(packages)
		for _, pkg := range packages {
			candidates := d.servicesForPackage(family, pkg)
			if len(candidates) != 1 {
				continue
			}
			service := candidates[0]
			existing, loaded := d.proposals[service.ID]
			if loaded && len(existing.Edges) > 0 {
				existing.Evidence = append(existing.Evidence, Evidence{Signal: "package", Ref: manifestFor[family], Detail: pkg})
				continue
			}
			p := d.proposal(service)
			p.DeclaredOnly = true
			p.Evidence = append(p.Evidence, Evidence{Signal: "package", Ref: manifestFor[family], Detail: pkg + " (declared, not loaded by any file)"})
		}
	}
}

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
	for _, file := range []string{"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"} {
		body, ok := d.in.Config[file]
		if !ok {
			continue
		}
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
	platformFiles := map[string]string{
		"fly.toml": "fly/platform", "netlify.toml": "netlify/platform", "render.yaml": "render/platform",
		"railway.json": "railway/platform", "railway.toml": "railway/platform", "Dockerfile": "docker/docker",
	}
	for file, service := range platformFiles {
		if _, ok := d.in.Config[file]; !ok {
			continue
		}
		if s, ok := d.in.Registry.Get(service); ok {
			p := d.proposal(s)
			p.Evidence = append(p.Evidence, Evidence{Signal: "config", Ref: file})
		}
	}
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
	}
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
		var claimants []*Proposal
		ids := make([]string, 0, len(d.proposals))
		for id := range d.proposals {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			p := d.proposals[id]
			if s, ok := d.in.Registry.Get(id); ok && envMatches(s, name) {
				claimants = append(claimants, p)
			}
		}
		if len(claimants) > 0 {
			sort.SliceStable(claimants, func(i, j int) bool {
				loadedI, loadedJ := len(claimants[i].Edges) > 0, len(claimants[j].Edges) > 0
				if loadedI != loadedJ {
					return loadedI
				}
				return rolePriority(claimants[i]) < rolePriority(claimants[j])
			})
			req.Service = claimants[0].Service
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
