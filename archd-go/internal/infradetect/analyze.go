// Package infradetect proposes a project's infrastructure from evidence the
// index already has: the packages each file loads, the environment variables
// it reads, the import graph, and a few configuration files
// (docs/INFRA.md L2, "propose, then confirm").
//
// Analyze is pure: it takes the evidence and returns proposals, so the rules
// are tested without a database. Apply persists them.
package infradetect

import (
	"path"
	"regexp"
	"sort"
	"strings"

	"axiom.local/archd/internal/registry"
)

// File is one indexed source file.
type File struct {
	ID       string
	RelPath  string
	Language string
}

// Import is one file-to-file import edge (static, require or dynamic).
type Import struct{ From, To string }

// PackageUse is one file loading an external package at a line.
type PackageUse struct {
	FileID  string
	Package string
	Line    int
}

// EnvRead is one file reading an environment variable at a line.
type EnvRead struct {
	FileID string
	Name   string
	Line   int
}

// Inputs is everything detection looks at for one root.
type Inputs struct {
	Files    []File
	Imports  []Import
	Packages []PackageUse
	EnvReads []EnvRead
	// Config holds project files detection reads directly, by relative path:
	// package manifests, .env.example / .env, docker-compose.yml, vercel.json,
	// .github/workflows/*.yml, fly.toml, ...
	Config map[string][]byte
	// Sources holds the text of files detection searches for literals (a
	// cron route's handler). Loaded only when config asks for such a search.
	Sources map[string][]byte
	// ReadSource returns a file's text on demand (nil when unreadable). Only
	// files touching a database or queue are read, for their contracts.
	ReadSource func(relPath string) []byte
	Registry   *registry.Registry
}

// Evidence is one reason a proposal exists.
type Evidence struct {
	Signal string `json:"signal"` // package | import | env | config
	Ref    string `json:"ref"`    // file:line, or a config file
	Detail string `json:"detail,omitempty"`
}

// Implementation is one thing that fills the role in an environment.
type Implementation struct {
	Environment string `json:"environment"`
	Kind        string `json:"kind"` // in-process | local-service | emulator | vendor
	Ref         string `json:"ref"`
	Evidence    string `json:"evidence,omitempty"`
	Source      string `json:"source,omitempty"` // "parser" for detected entries
}

// Edge is a proposed relationship from a file to the node.
type Edge struct {
	FileID string
	Kind   string // IMPLEMENTS | USES | SCHEDULED_BY | ...
	// Item names the contents item the edge is about ("bookings"), when the
	// evidence is that specific.
	Item     string
	Evidence string
}

// Content is a proposed contract item.
type Content struct {
	Kind     string
	Name     string
	Detail   map[string]any
	Evidence string
}

// Proposal is one infra node detection believes in, with everything that
// justifies it.
type Proposal struct {
	Service string
	// Instance tells apart several nodes of one service: each Dockerfile is its
	// own container ("api", "worker"). Empty for one-per-project services.
	Instance        string
	Name            string
	Category        string
	Provider        string
	Subtype         string
	Evidence        []Evidence
	Implementations []Implementation
	Edges           []Edge
	Contents        []Content
	// DeclaredOnly: a manifest lists the package but no file loads it.
	DeclaredOnly bool
}

// Requirement is an environment variable the project reads or declares,
// tied to a proposal's service when the registry's env patterns say so.
type Requirement struct {
	Name     string
	Service  string // "" when no role claims it
	Evidence string
	Present  bool // defined in a local .env file (names only)
}

// Unresolved is evidence detection saw but could not attribute to exactly one
// service - boto3 alone could be any of five AWS services. The agent decides.
type Unresolved struct {
	Package    string
	Candidates []string
	Evidence   string
}

// Result is the full detection output for one root.
type Result struct {
	Proposals    []Proposal
	Requirements []Requirement
	Unresolved   []Unresolved
}

// languageFamily maps an indexed language to the registry's package keys.
func languageFamily(language string) string {
	switch language {
	case "typescript", "tsx", "javascript", "jsx":
		return "js"
	case "python":
		return "py"
	case "go":
		return "go"
	case "java", "kotlin":
		return "java"
	case "csharp":
		return "cs"
	case "ruby":
		return "rb"
	case "rust":
		return "rs"
	}
	return ""
}

// Analyze turns evidence into proposals.
func Analyze(in Inputs) Result {
	d := newDetection(in)
	d.matchPackages()
	d.dropInfraJobs()
	d.readManifests()
	d.readConfig()
	d.collectRequirements()
	d.linkEnvReaders()
	d.extractSchedules()
	d.extractContracts()
	return d.result()
}

type detection struct {
	in          Inputs
	files       map[string]File
	importers   map[string][]string // file → files importing it
	imports     map[string][]string // file → files it imports
	envByName   map[string][]EnvRead
	envDeclared map[string]string // name → declaring config file:line
	envPresent  map[string]bool
	proposals   map[string]*Proposal
	unresolved  []Unresolved
	requirement []Requirement
}

func newDetection(in Inputs) *detection {
	d := &detection{
		in: in, files: map[string]File{}, importers: map[string][]string{}, imports: map[string][]string{},
		envByName: map[string][]EnvRead{}, envDeclared: map[string]string{}, envPresent: map[string]bool{},
		proposals: map[string]*Proposal{},
	}
	for _, f := range in.Files {
		d.files[f.ID] = f
	}
	for _, imp := range in.Imports {
		if imp.From == imp.To {
			continue
		}
		d.importers[imp.To] = append(d.importers[imp.To], imp.From)
		d.imports[imp.From] = append(d.imports[imp.From], imp.To)
	}
	for _, r := range in.EnvReads {
		d.envByName[r.Name] = append(d.envByName[r.Name], r)
	}
	d.readEnvFiles()
	return d
}

// proposalKey identifies a proposal across runs: the service, and the
// instance when a service can appear more than once.
func proposalKey(p *Proposal) string {
	if p.Instance == "" {
		return p.Service
	}
	return p.Service + "#" + p.Instance
}

// instance is the proposal for one of several nodes of a service.
func (d *detection) instance(service registry.Service, instance string) *Proposal {
	key := service.ID + "#" + instance
	if p, ok := d.proposals[key]; ok {
		return p
	}
	p := &Proposal{Service: service.ID, Instance: instance, Name: service.Name + " · " + instance,
		Category: service.Category, Provider: service.Provider, Subtype: service.Subtype}
	d.proposals[key] = p
	return p
}

func (d *detection) proposal(service registry.Service) *Proposal {
	if p, ok := d.proposals[service.ID]; ok {
		return p
	}
	p := &Proposal{Service: service.ID, Name: service.Name, Category: service.Category,
		Provider: service.Provider, Subtype: service.Subtype}
	d.proposals[service.ID] = p
	return p
}

// servicesForPackage lists registry services whose detection signatures name
// the package for this language family. Go matches by module prefix.
func (d *detection) servicesForPackage(family, pkg string) []registry.Service {
	var out []registry.Service
	for _, s := range d.in.Registry.All() {
		if s.Detect == nil {
			continue
		}
		for _, candidate := range s.Detect.Packages[family] {
			if candidate == pkg || (family == "go" && strings.HasPrefix(pkg, candidate+"/")) ||
				((family == "py" || family == "java" || family == "cs") && strings.HasPrefix(pkg, candidate+".")) ||
				(family == "rb" && strings.HasPrefix(pkg, candidate+"/")) {
				out = append(out, s)
				break
			}
		}
	}
	return out
}

// envNames is every variable read in code or declared in env files.
func (d *detection) envNames() []string {
	seen := map[string]bool{}
	var out []string
	for name := range d.envByName {
		seen[name] = true
		out = append(out, name)
	}
	for name := range d.envDeclared {
		if !seen[name] {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// roleEnvPrefixes are variable names that belong to a role whatever fills it.
var roleEnvPrefixes = map[string][]string{
	"email":         {"MAIL_", "SMTP_", "EMAIL_"},
	"database":      {"DB_", "DATABASE_"},
	"cache":         {"CACHE_"},
	"queue":         {"QUEUE_"},
	"storage":       {"STORAGE_", "BUCKET_"},
	"observability": {"LOG_LEVEL", "OTEL_"},
}

// envMatches reports whether a variable belongs to a service: its registry
// patterns, its provider's own prefix (AWS_REGION is an AWS setting whichever
// AWS service reads it), or its role's generic prefixes.
func envMatches(s registry.Service, name string) bool {
	return envMatchStrength(s, name) > 0
}

// envMatchStrength ranks how specifically a service claims a variable: its
// own exact name (4), a pattern of its own (3), its provider's prefix (2), or
// only its role's generic prefix (1). DATABASE_URL is Postgres's by pattern
// and only generically MongoDB's.
func envMatchStrength(s registry.Service, name string) int {
	best := 0
	if s.Detect != nil {
		for _, pattern := range s.Detect.EnvPatterns {
			if name == pattern {
				return 4
			}
			if strings.HasPrefix(name, pattern) {
				best = 3
			}
		}
	}
	if best == 0 && s.Provider != "" && s.Provider != "generic" {
		prefix := strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(s.Provider)) + "_"
		if strings.HasPrefix(name, prefix) {
			best = 2
		}
	}
	if best == 0 {
		for _, prefix := range roleEnvPrefixes[s.Category] {
			if strings.HasPrefix(name, prefix) {
				best = 1
			}
		}
	}
	return best
}

// matchPackages attributes every package use to a service and separates the
// role's own files (IMPLEMENTS) from the files that use it (USES).
func (d *detection) matchPackages() {
	byService := map[string][]PackageUse{}
	services := map[string]registry.Service{}
	for _, use := range d.in.Packages {
		file, ok := d.files[use.FileID]
		if !ok {
			continue
		}
		family := languageFamily(file.Language)
		candidates := d.servicesForPackage(family, use.Package)
		if len(candidates) > 1 {
			candidates = d.narrowBySource(file, candidates)
		}
		if len(candidates) > 1 {
			candidates = d.narrowByEnv(candidates)
		}
		switch len(candidates) {
		case 0:
			continue
		case 1:
			byService[candidates[0].ID] = append(byService[candidates[0].ID], use)
			services[candidates[0].ID] = candidates[0]
		default:
			ids := make([]string, 0, len(candidates))
			for _, c := range candidates {
				ids = append(ids, c.ID)
			}
			d.unresolved = append(d.unresolved, Unresolved{Package: use.Package, Candidates: ids,
				Evidence: ref(file.RelPath, use.Line)})
		}
	}
	for id, uses := range byService {
		p := d.proposal(services[id])
		if p.Category == "scheduler" {
			d.attributeScheduler(p, uses)
			continue
		}
		d.attribute(p, uses)
	}
}

// attributeScheduler: the file that loads a scheduler SDK is the scheduler
// (IMPLEMENTS); the files it loads to run are the jobs (SCHEDULED_BY). Jobs
// are entry points no caller reaches, which is exactly what the map needs to
// say about them.
func (d *detection) attributeScheduler(p *Proposal, uses []PackageUse) {
	seen := map[string]bool{}
	for _, use := range uses {
		if seen[use.FileID] {
			continue
		}
		seen[use.FileID] = true
		file := d.files[use.FileID]
		p.Evidence = append(p.Evidence, Evidence{Signal: "import", Ref: ref(file.RelPath, use.Line), Detail: use.Package})
		p.Implementations = append(p.Implementations, Implementation{Environment: "local", Kind: "in-process",
			Ref: file.RelPath, Evidence: ref(file.RelPath, use.Line), Source: "parser"})
		p.Edges = append(p.Edges, Edge{FileID: use.FileID, Kind: "IMPLEMENTS", Evidence: ref(file.RelPath, use.Line)})
		for _, job := range d.imports[use.FileID] {
			if d.loadsAnyPackage(job) {
				continue
			}
			p.Edges = append(p.Edges, Edge{FileID: job, Kind: "SCHEDULED_BY",
				Evidence: d.files[job].RelPath + " (loaded by " + file.RelPath + ")"})
		}
	}
	sortProposal(p)
}

// dropInfraJobs removes "jobs" that are another role's own files: a scheduler
// importing the error reporter to wrap its jobs does not schedule the error
// reporter.
func (d *detection) dropInfraJobs() {
	roleFiles := map[string]bool{}
	for _, p := range d.proposals {
		for _, e := range p.Edges {
			if e.Kind == "IMPLEMENTS" {
				roleFiles[e.FileID] = true
			}
		}
	}
	for _, p := range d.proposals {
		kept := p.Edges[:0]
		for _, e := range p.Edges {
			if e.Kind == "SCHEDULED_BY" && roleFiles[e.FileID] {
				continue
			}
			kept = append(kept, e)
		}
		p.Edges = kept
	}
}

func (d *detection) narrowByEnv(candidates []registry.Service) []registry.Service {
	var hit []registry.Service
	for _, c := range candidates {
		for _, name := range d.envNames() {
			if envMatches(c, name) {
				hit = append(hit, c)
				break
			}
		}
	}
	if len(hit) > 0 {
		return hit
	}
	return candidates
}

// attribute builds the role's family from the files that load its SDK:
//
//   - an SDK file other files import is an adapter: it IMPLEMENTS the role;
//   - a file in the adapter's folder that imports it is the role's facade and
//     IMPLEMENTS it too;
//   - a file in that folder the facade loads, which does not load the SDK, is
//     an in-process stand-in: it IMPLEMENTS the role locally;
//   - every other importer of the adapter or facade USES the role;
//   - an SDK file nothing imports uses the SDK directly: it USES the role.
func (d *detection) attribute(p *Proposal, uses []PackageUse) {
	sdkFiles := map[string]PackageUse{}
	for _, use := range uses {
		if existing, ok := sdkFiles[use.FileID]; !ok || use.Line < existing.Line {
			sdkFiles[use.FileID] = use
		}
	}
	family := map[string]string{} // file → why it belongs to the role
	users := map[string]string{}
	for fileID, use := range sdkFiles {
		file := d.files[fileID]
		p.Evidence = append(p.Evidence, Evidence{Signal: "import", Ref: ref(file.RelPath, use.Line), Detail: use.Package})
		importers := d.importers[fileID]
		if len(importers) == 0 {
			users[fileID] = ref(file.RelPath, use.Line)
			continue
		}
		family[fileID] = ref(file.RelPath, use.Line)
		p.Implementations = append(p.Implementations, Implementation{Environment: "local", Kind: "vendor",
			Ref: file.RelPath, Evidence: ref(file.RelPath, use.Line), Source: "parser"})
		dir := path.Dir(file.RelPath)
		for _, importer := range importers {
			if path.Dir(d.files[importer].RelPath) == dir {
				family[importer] = d.files[importer].RelPath + " (loads " + path.Base(file.RelPath) + ")"
			}
		}
	}
	// Stand-ins: what a facade loads from its own folder without the SDK.
	for member := range family {
		if _, isSDK := sdkFiles[member]; isSDK {
			continue
		}
		dir := path.Dir(d.files[member].RelPath)
		for _, loaded := range d.imports[member] {
			if _, ok := family[loaded]; ok || path.Dir(d.files[loaded].RelPath) != dir {
				continue
			}
			if d.loadsAnyPackage(loaded) {
				continue // another vendor's adapter sharing the folder
			}
			family[loaded] = d.files[loaded].RelPath + " (stand-in loaded by " + path.Base(d.files[member].RelPath) + ")"
			p.Implementations = append(p.Implementations, Implementation{Environment: "local", Kind: "in-process",
				Ref: d.files[loaded].RelPath, Evidence: d.files[member].RelPath, Source: "parser"})
		}
	}
	for member := range family {
		for _, importer := range d.importers[member] {
			if _, inFamily := family[importer]; !inFamily {
				users[importer] = d.files[importer].RelPath + " (imports " + d.files[member].RelPath + ")"
			}
		}
	}
	for fileID, why := range family {
		p.Edges = append(p.Edges, Edge{FileID: fileID, Kind: "IMPLEMENTS", Evidence: why})
	}
	for fileID, why := range users {
		p.Edges = append(p.Edges, Edge{FileID: fileID, Kind: "USES", Evidence: why})
	}
	sortProposal(p)
}

func (d *detection) loadsAnyPackage(fileID string) bool {
	for _, use := range d.in.Packages {
		if use.FileID == fileID {
			family := languageFamily(d.files[fileID].Language)
			if len(d.servicesForPackage(family, use.Package)) > 0 {
				return true
			}
		}
	}
	return false
}

// extractSchedules reads cron expressions from files that load a scheduler
// SDK: `cron.schedule('*/5 * * * *', ...)` and wrappers around it.
var cronLiteral = regexp.MustCompile(`['"]((?:[0-9*/,\-]+\s+){4}[0-9*/,\-]+(?:\s+[0-9*/,\-]+)?)['"]\s*,\s*(?:['"]([^'"]+)['"])?`)

func (d *detection) extractSchedules() {
	for _, p := range d.proposals {
		if p.Category != "scheduler" {
			continue
		}
		for _, edge := range p.Edges {
			file := d.files[edge.FileID]
			source := d.in.Config[file.RelPath]
			if source == nil {
				continue
			}
			for _, match := range cronLiteral.FindAllSubmatchIndex(source, -1) {
				expr := string(source[match[2]:match[3]])
				name := expr
				if match[4] >= 0 {
					name = string(source[match[4]:match[5]])
				}
				p.Contents = append(p.Contents, Content{Kind: "schedule", Name: name,
					Detail: map[string]any{"cron": expr}, Evidence: ref(file.RelPath, lineAt(source, match[0]))})
			}
		}
	}
}

func (d *detection) result() Result {
	var out Result
	ids := make([]string, 0, len(d.proposals))
	for id := range d.proposals {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		sortProposal(d.proposals[id])
		out.Proposals = append(out.Proposals, *d.proposals[id])
	}
	out.Requirements = d.requirement
	out.Unresolved = d.unresolved
	return out
}

func sortProposal(p *Proposal) {
	sort.Slice(p.Edges, func(i, j int) bool {
		if p.Edges[i].Kind != p.Edges[j].Kind {
			return p.Edges[i].Kind < p.Edges[j].Kind
		}
		if p.Edges[i].FileID != p.Edges[j].FileID {
			return p.Edges[i].FileID < p.Edges[j].FileID
		}
		return p.Edges[i].Item < p.Edges[j].Item
	})
	sort.Slice(p.Implementations, func(i, j int) bool {
		return p.Implementations[i].Kind+p.Implementations[i].Ref < p.Implementations[j].Kind+p.Implementations[j].Ref
	})
	sort.Slice(p.Evidence, func(i, j int) bool {
		if p.Evidence[i].Ref != p.Evidence[j].Ref {
			return p.Evidence[i].Ref < p.Evidence[j].Ref
		}
		return p.Evidence[i].Signal+p.Evidence[i].Detail < p.Evidence[j].Signal+p.Evidence[j].Detail
	})
	// Two readers noticing the same file is one reason, not two.
	kept := p.Evidence[:0]
	for i, e := range p.Evidence {
		if i > 0 && e == p.Evidence[i-1] {
			continue
		}
		kept = append(kept, e)
	}
	p.Evidence = kept
}

func ref(relPath string, line int) string {
	if line <= 0 {
		return relPath
	}
	return relPath + ":" + itoa(line)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func lineAt(source []byte, offset int) int {
	line := 1
	for i := 0; i < offset && i < len(source); i++ {
		if source[i] == '\n' {
			line++
		}
	}
	return line
}
