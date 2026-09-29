package infradetect

import (
	"regexp"
	"strings"

	"axiom.local/archd/internal/registry"
)

var (
	urlLiteral    = regexp.MustCompile("[\"'`]([a-z][a-z0-9+.-]*://[^\"'`\\s]*)")
	clientLiteral = regexp.MustCompile(`\.(?:client|resource|Client|Session)\(\s*["']([A-Za-z0-9-]+)["']`)
	urlPatternMu  = map[string]*regexp.Regexp{}
)

// narrowBySource settles a package several services share by what the file
// says: a connection URL (SQLAlchemy with "postgresql://..." is Postgres) or
// the client it creates (boto3.client("s3") is S3). Returns the candidates
// unchanged when the source says nothing.
func (d *detection) narrowBySource(file File, candidates []registry.Service) []registry.Service {
	if d.in.ReadSource == nil {
		return candidates
	}
	source := d.in.ReadSource(file.RelPath)
	if source == nil {
		return candidates
	}
	var urls, clients []string
	for _, m := range urlLiteral.FindAllSubmatch(source, -1) {
		urls = append(urls, string(m[1]))
	}
	for _, m := range clientLiteral.FindAllSubmatch(source, -1) {
		clients = append(clients, strings.ToLower(string(m[1])))
	}
	if len(urls) == 0 && len(clients) == 0 {
		return candidates
	}
	var hit []registry.Service
	for _, c := range candidates {
		if c.Detect == nil {
			continue
		}
		matched := false
		for _, pattern := range c.Detect.URLPatterns {
			re, ok := urlPatternMu[pattern]
			if !ok {
				re, _ = regexp.Compile(pattern)
				urlPatternMu[pattern] = re
			}
			for _, url := range urls {
				if re != nil && re.MatchString(url) {
					matched = true
				}
			}
		}
		short := c.ID[strings.LastIndex(c.ID, "/")+1:]
		for _, client := range clients {
			if client == short {
				matched = true
			}
		}
		if matched {
			hit = append(hit, c)
		}
	}
	if len(hit) > 0 {
		return hit
	}
	return candidates
}

// linkEnvReaders: a file that reads a service's own variable connects to it
// (celery_app.py reading RABBITMQ_URL talks to RabbitMQ) even when no SDK
// import says so. A file reading variables for three or more services is a
// config module, not a user of each.
func (d *detection) linkEnvReaders() {
	servicesByFile := map[string]map[string]bool{}
	type link struct {
		file, service, name string
		line                int
	}
	var links []link
	for _, req := range d.requirement {
		if req.Service == "" {
			continue
		}
		s, ok := d.in.Registry.Get(req.Service)
		if !ok || envMatchStrength(s, req.Name) < 2 {
			continue
		}
		for _, read := range d.envByName[req.Name] {
			if servicesByFile[read.FileID] == nil {
				servicesByFile[read.FileID] = map[string]bool{}
			}
			servicesByFile[read.FileID][req.Service] = true
			links = append(links, link{read.FileID, req.Service, req.Name, read.Line})
		}
	}
	seen := map[[2]string]bool{}
	for _, l := range links {
		if len(servicesByFile[l.file]) >= 3 || seen[[2]string{l.file, l.service}] {
			continue
		}
		seen[[2]string{l.file, l.service}] = true
		p := d.proposals[l.service]
		if p == nil {
			continue
		}
		connected := false
		for _, e := range p.Edges {
			connected = connected || e.FileID == l.file
		}
		if connected {
			continue
		}
		file := d.files[l.file]
		p.Edges = append(p.Edges, Edge{FileID: l.file, Kind: "USES",
			Evidence: ref(file.RelPath, l.line) + " (reads " + l.name + ")"})
	}
}
