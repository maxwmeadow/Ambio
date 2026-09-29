package infradetect

import (
	"path"
	"regexp"
	"sort"
	"strings"
)

// extractContracts fills in what code depends on inside a database or a
// queue (INFRA_LAYER_PLAN.md L4): tables from migrations and who reads or
// writes each, topics and who publishes or consumes each. Import evidence says
// a file uses Postgres; this says it writes bookings.
func (d *detection) extractContracts() {
	if d.in.ReadSource == nil {
		return
	}
	d.extractTables()
	d.extractTopics()
}

var (
	createTable = regexp.MustCompile(`(?is)create\s+table\s+(?:if\s+not\s+exists\s+)?["` + "`" + `]?([a-z_][a-z0-9_]*)["` + "`" + `]?\s*\((.*?)\n\s*\)`)
	prismaModel = regexp.MustCompile(`(?m)^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{`)
	sqlWrite    = regexp.MustCompile(`(?i)\b(?:insert\s+into|update|delete\s+from)\s+["` + "`" + `]?([a-z_][a-z0-9_]*)`)
	// The optional "delete" consumes DELETE FROM, which is a write, not a read.
	sqlRead    = regexp.MustCompile(`(?i)(?:\bdelete\s+)?\b(?:from|join)\s+["` + "`" + `]?([a-z_][a-z0-9_]*)`)
	columnName = regexp.MustCompile(`(?m)^\s*["` + "`" + `]?([a-z_][a-z0-9_]*)["` + "`" + `]?\s+[a-z]`)
)

// sqlDatabase picks the node SQL belongs to: the one SQL database proposal,
// or the one with the most users when there are several.
func (d *detection) sqlDatabase() *Proposal {
	var best *Proposal
	for _, p := range d.proposals {
		if p.Category != "database" || (p.Subtype != "" && p.Subtype != "sql") {
			continue
		}
		if best == nil || len(p.Edges) > len(best.Edges) || (len(p.Edges) == len(best.Edges) && p.Service < best.Service) {
			best = p
		}
	}
	return best
}

func (d *detection) extractTables() {
	db := d.sqlDatabase()
	if db == nil {
		return
	}
	tables := map[string]bool{}
	var files []string
	for file := range d.in.Config {
		if strings.HasSuffix(file, ".sql") || path.Base(file) == "schema.prisma" {
			files = append(files, file)
		}
	}
	sort.Strings(files)
	// Schema kept in code (a CREATE TABLE string in the adapter, or in a file
	// that opens the driver directly) counts too.
	sources := map[string][]byte{}
	var adapters []string
	for _, edge := range db.Edges {
		if edge.Kind != "IMPLEMENTS" && edge.Kind != "USES" {
			continue
		}
		rel := d.files[edge.FileID].RelPath
		if _, seen := sources[rel]; !seen {
			sources[rel] = d.in.ReadSource(rel)
			adapters = append(adapters, rel)
		}
	}
	sort.Strings(adapters)
	files = append(files, adapters...)
	for _, file := range files {
		body, ok := d.in.Config[file]
		if !ok {
			body = sources[file]
		}
		if path.Base(file) == "schema.prisma" {
			for _, m := range prismaModel.FindAllSubmatchIndex(body, -1) {
				name := strings.ToLower(string(body[m[2]:m[3]]))
				if !tables[name] {
					tables[name] = true
					db.Contents = append(db.Contents, Content{Kind: "table", Name: name, Evidence: ref(file, lineAt(body, m[0]))})
				}
			}
			continue
		}
		for _, m := range createTable.FindAllSubmatchIndex(body, -1) {
			name := strings.ToLower(string(body[m[2]:m[3]]))
			if tables[name] {
				continue
			}
			tables[name] = true
			var columns []string
			for _, col := range columnName.FindAllSubmatch(body[m[4]:m[5]], -1) {
				word := strings.ToLower(string(col[1]))
				switch word {
				case "primary", "foreign", "unique", "constraint", "check", "key", "index":
					continue
				}
				columns = append(columns, word)
			}
			db.Contents = append(db.Contents, Content{Kind: "table", Name: name,
				Detail: map[string]any{"columns": columns}, Evidence: ref(file, lineAt(body, m[0]))})
		}
	}
	if len(tables) == 0 {
		return
	}
	// Who reads and writes each table: SQL in the files that touch the node.
	type key struct{ file, kind, table string }
	seen := map[key]bool{}
	for _, edge := range append([]Edge(nil), db.Edges...) {
		if edge.Kind != "USES" && edge.Kind != "IMPLEMENTS" {
			continue
		}
		file := d.files[edge.FileID]
		source := d.in.ReadSource(file.RelPath)
		if source == nil {
			continue
		}
		record := func(pattern *regexp.Regexp, kind string) {
			for _, m := range pattern.FindAllSubmatchIndex(source, -1) {
				if kind == "READS" && strings.HasPrefix(strings.ToLower(string(source[m[0]:m[1]])), "delete") {
					continue
				}
				table := strings.ToLower(string(source[m[2]:m[3]]))
				k := key{edge.FileID, kind, table}
				if !tables[table] || seen[k] {
					continue
				}
				seen[k] = true
				db.Edges = append(db.Edges, Edge{FileID: edge.FileID, Kind: kind, Item: table,
					Evidence: ref(file.RelPath, lineAt(source, m[0]))})
			}
		}
		record(sqlWrite, "WRITES")
		record(sqlRead, "READS")
	}
	sortProposal(db)
}

var (
	topicCall     = regexp.MustCompile(`\.(publish|consume|subscribe)\s*(?:<[^>]*>)?\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+))`)
	constantEntry = regexp.MustCompile(`(?m)^\s*([A-Za-z_$][\w$]*)\s*:\s*['"]([^'"]+)['"]`)
)

// extractTopics finds the topics a queue carries from the calls its users
// make. Named constants (TOPICS.bookingConfirmed) resolve through the files
// the caller imports, one hop.
func (d *detection) extractTopics() {
	for _, q := range d.proposals {
		if q.Category != "queue" {
			continue
		}
		publishers := map[string]map[string]string{} // topic → file → evidence
		consumers := map[string]map[string]string{}
		type key struct{ file, kind, topic string }
		seen := map[key]bool{}
		for _, edge := range append([]Edge(nil), q.Edges...) {
			if edge.Kind != "USES" {
				continue
			}
			file := d.files[edge.FileID]
			source := d.in.ReadSource(file.RelPath)
			if source == nil {
				continue
			}
			constants := map[string]string{}
			for _, imported := range append([]string{edge.FileID}, d.imports[edge.FileID]...) {
				body := source
				if imported != edge.FileID {
					body = d.in.ReadSource(d.files[imported].RelPath)
				}
				for _, m := range constantEntry.FindAllSubmatch(body, -1) {
					constants[string(m[1])] = string(m[2])
				}
			}
			for _, m := range topicCall.FindAllSubmatchIndex(source, -1) {
				verb := string(source[m[2]:m[3]])
				topic := ""
				switch {
				case m[4] >= 0:
					topic = string(source[m[4]:m[5]])
				case m[6] >= 0:
					topic = string(source[m[6]:m[7]])
				case m[8] >= 0:
					expr := string(source[m[8]:m[9]])
					topic = constants[expr[strings.LastIndex(expr, ".")+1:]]
				}
				if topic == "" {
					continue
				}
				kind := "CONSUMES"
				bucket := consumers
				if verb == "publish" {
					kind = "PUBLISHES"
					bucket = publishers
				}
				evidence := ref(file.RelPath, lineAt(source, m[0]))
				if bucket[topic] == nil {
					bucket[topic] = map[string]string{}
				}
				bucket[topic][file.RelPath] = evidence
				k := key{edge.FileID, kind, topic}
				if !seen[k] {
					seen[k] = true
					q.Edges = append(q.Edges, Edge{FileID: edge.FileID, Kind: kind, Item: topic, Evidence: evidence})
				}
			}
		}
		topics := map[string]bool{}
		for t := range publishers {
			topics[t] = true
		}
		for t := range consumers {
			topics[t] = true
		}
		names := make([]string, 0, len(topics))
		for t := range topics {
			names = append(names, t)
		}
		sort.Strings(names)
		for _, topic := range names {
			detail := map[string]any{"publishers": sortedKeys(publishers[topic]), "consumers": sortedKeys(consumers[topic])}
			evidence := firstValue(publishers[topic])
			if evidence == "" {
				evidence = firstValue(consumers[topic])
			}
			// The gap that loses messages silently: sent, nobody listening.
			if len(consumers[topic]) == 0 {
				detail["warning"] = "published, but nothing consumes it"
			} else if len(publishers[topic]) == 0 {
				detail["warning"] = "consumed, but nothing publishes it"
			}
			q.Contents = append(q.Contents, Content{Kind: "topic", Name: topic, Detail: detail, Evidence: evidence})
		}
		sortProposal(q)
	}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func firstValue(m map[string]string) string {
	keys := sortedKeys(m)
	if len(keys) == 0 {
		return ""
	}
	return m[keys[0]]
}
