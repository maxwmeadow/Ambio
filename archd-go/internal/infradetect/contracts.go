package infradetect

import (
	"bytes"
	"path"
	"regexp"
	"sort"
	"strings"
)

// extractContracts fills in what code depends on inside a database or a
// queue (docs/INFRA.md L4): tables from migrations and who reads or
// writes each, topics and who publishes or consumes each. Import evidence says
// a file uses Postgres; this says it writes bookings.
func (d *detection) extractContracts() {
	if d.in.ReadSource == nil {
		return
	}
	d.extractTables()
	d.extractTopics()
	d.extractCollections()
	d.extractCacheKeys()
	d.extractFlagsAndModels()
}

var (
	createTable = regexp.MustCompile(`(?is)create\s+table\s+(?:if\s+not\s+exists\s+)?["` + "`" + `]?([a-z_][a-z0-9_]*)["` + "`" + `]?\s*\((.*?)\n\s*\)`)
	prismaModel = regexp.MustCompile(`(?m)^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{`)
	sqlWrite    = regexp.MustCompile(`(?i)\b(?:insert\s+into|update|delete\s+from)\s+["` + "`" + `]?([a-z_][a-z0-9_]*)`)
	// The optional "delete" consumes DELETE FROM, which is a write, not a read.
	sqlRead = regexp.MustCompile(`(?i)(?:\bdelete\s+)?\b(?:from|join)\s+["` + "`" + `]?([a-z_][a-z0-9_]*)`)
	// Prisma model calls name the table: prisma.orderItem.create writes it.
	prismaWrite = regexp.MustCompile(`\b\w+\.([a-zA-Z_]\w*)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(`)
	prismaRead  = regexp.MustCompile(`\b\w+\.([a-zA-Z_]\w*)\.(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\(`)
	columnName  = regexp.MustCompile(`(?m)^\s*["` + "`" + `]?([a-z_][a-z0-9_]*)["` + "`" + `]?\s+[a-z]`)
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
		record(prismaWrite, "WRITES")
		record(prismaRead, "READS")
	}
	sortProposal(db)
}

// A topic expression: a string literal, or a constant (TOPICS.orderPlaced,
// ORDER_TOPIC) resolved through the file and what it imports.
const topicExpr = "('[^'\\n]+'|\"[^\"\\n]+\"|`[^`$\\n]+`|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)"

// topicPatterns are how common clients name the topic or queue they send to
// or read from. Each captures one topicExpr.
var topicPatterns = []struct {
	re   *regexp.Regexp
	kind string
	// needs is a word the file must contain for the pattern to count (kombu's
	// Queue(...) is a consumer only next to a Consumer).
	needs string
}{
	{regexp.MustCompile(`\.(?:publish|sendToQueue|produce)\s*(?:<[^>]*>)?\(\s*` + topicExpr), "PUBLISHES", ""},
	{regexp.MustCompile(`\.send\(\s*\{\s*topic\s*:\s*` + topicExpr), "PUBLISHES", ""},
	{regexp.MustCompile(`(?s)Writer\{[^}]*?Topic:\s*` + topicExpr), "PUBLISHES", ""},
	{regexp.MustCompile(`\b(?:KafkaProducer|Producer)\b[^\n]*\n?[^\n]*\.send\(\s*` + topicExpr), "PUBLISHES", ""},
	{regexp.MustCompile(`\.(?:consume|subscribe)\s*(?:<[^>]*>)?\(\s*` + topicExpr), "CONSUMES", ""},
	{regexp.MustCompile(`\.subscribe\(\s*\{\s*topics?\s*:\s*\[?\s*` + topicExpr), "CONSUMES", ""},
	{regexp.MustCompile(`\.subscribe\(\s*\[\s*` + topicExpr), "CONSUMES", ""},
	{regexp.MustCompile(`(?s)ReaderConfig\{[^}]*?Topic:\s*` + topicExpr), "CONSUMES", ""},
	{regexp.MustCompile(`\bKafkaConsumer\(\s*` + topicExpr), "CONSUMES", ""},
	{regexp.MustCompile(`\bnew\s+Worker\s*(?:<[^>]*>)?\(\s*` + topicExpr), "CONSUMES", ""},
	{regexp.MustCompile(`\bQueue\(\s*` + topicExpr), "CONSUMES", "Consumer"},
}

var (
	constantEntry = regexp.MustCompile(`(?m)^\s*([A-Za-z_$][\w$]*)\s*:\s*['"]([^'"]+)['"]`)
	constantDecl  = regexp.MustCompile(`(?m)^\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*\w+\s*)?=\s*['"]([^'"\n]+)['"]`)
	exportedFunc  = regexp.MustCompile(`(?m)^\s*(?:export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|def\s+([a-z_][\w]*)\s*\(|func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\()`)
	publishVerb   = regexp.MustCompile(`(?i)^(emit|publish|send|produce|enqueue|dispatch|push|notify|broadcast|fire)`)
	consumeVerb   = regexp.MustCompile(`(?i)^(consume|subscribe|listen|handle|process|register|on[A-Z])`)
)

// extractTopics finds the topics (or queues) a queue carries and who sends
// and receives each, from the calls its users and adapters make. The adapter's
// own wrappers count too: emit(TOPICS.orderPlaced) in a service that imports
// the Kafka adapter's emit() publishes orders.placed.
func (d *detection) extractTopics() {
	for _, q := range d.proposals {
		if q.Category != "queue" {
			continue
		}
		publishers := map[string]map[string]string{} // topic → file → evidence
		consumers := map[string]map[string]string{}
		type key struct{ file, kind, topic string }
		seen := map[key]bool{}

		// The adapter's exported functions, classified by their verb.
		wrappers := map[string]string{} // function name → kind
		for _, edge := range q.Edges {
			if edge.Kind != "IMPLEMENTS" {
				continue
			}
			source := d.in.ReadSource(d.files[edge.FileID].RelPath)
			for _, m := range exportedFunc.FindAllSubmatch(source, -1) {
				name := ""
				for _, g := range m[1:] {
					if len(g) > 0 {
						name = string(g)
					}
				}
				switch {
				case publishVerb.MatchString(name):
					wrappers[name] = "PUBLISHES"
				case consumeVerb.MatchString(name):
					wrappers[name] = "CONSUMES"
				}
			}
		}

		visited := map[string]bool{}
		for _, edge := range append([]Edge(nil), q.Edges...) {
			if (edge.Kind != "USES" && edge.Kind != "IMPLEMENTS") || visited[edge.FileID] {
				continue
			}
			visited[edge.FileID] = true
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
				for _, m := range constantDecl.FindAllSubmatch(body, -1) {
					constants[string(m[1])] = string(m[2])
				}
			}
			resolve := func(expr string) string {
				if expr == "" {
					return ""
				}
				switch expr[0] {
				case '\'', '"', '`':
					return expr[1 : len(expr)-1]
				}
				return constants[expr[strings.LastIndex(expr, ".")+1:]]
			}
			record := func(kind, topic string, offset int) {
				if topic == "" {
					return
				}
				bucket := consumers
				if kind == "PUBLISHES" {
					bucket = publishers
				}
				evidence := ref(file.RelPath, lineAt(source, offset))
				if bucket[topic] == nil {
					bucket[topic] = map[string]string{}
				}
				if _, ok := bucket[topic][file.RelPath]; !ok {
					bucket[topic][file.RelPath] = evidence
				}
				k := key{edge.FileID, kind, topic}
				if !seen[k] {
					seen[k] = true
					q.Edges = append(q.Edges, Edge{FileID: edge.FileID, Kind: kind, Item: topic, Evidence: evidence})
				}
			}
			for _, pattern := range topicPatterns {
				if pattern.needs != "" && !bytes.Contains(source, []byte(pattern.needs)) {
					continue
				}
				for _, m := range pattern.re.FindAllSubmatchIndex(source, -1) {
					record(pattern.kind, resolve(string(source[m[2]:m[3]])), m[0])
				}
			}
			for name, kind := range wrappers {
				call := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\s*(?:<[^>]*>)?\(\s*` + topicExpr)
				for _, m := range call.FindAllSubmatchIndex(source, -1) {
					// Skip the wrapper's own definition.
					if bytes.Contains(source[max(0, m[0]-16):m[0]], []byte("function")) {
						continue
					}
					record(kind, resolve(string(source[m[2]:m[3]])), m[0])
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
			// A near-identical name on the other side is almost always a typo.
			if len(consumers[topic]) == 0 {
				detail["warning"] = "published, but nothing in this project consumes it"
				if twin := nearMiss(topic, consumers); twin != "" {
					detail["warning"] = "published, but only \"" + twin + "\" is consumed - a typo?"
					detail["similar"] = twin
				}
			} else if len(publishers[topic]) == 0 {
				detail["warning"] = "consumed, but nothing in this project publishes it"
				if twin := nearMiss(topic, publishers); twin != "" {
					detail["warning"] = "consumed, but only \"" + twin + "\" is published - a typo?"
					detail["similar"] = twin
				}
			}
			q.Contents = append(q.Contents, Content{Kind: "topic", Name: topic, Detail: detail, Evidence: evidence})
		}
		sortProposal(q)
	}
}

// nearMiss finds a name on the other side that differs by a character or two:
// booking.reminder against booking.reminders, orders.placed against order.placed.
func nearMiss(topic string, other map[string]map[string]string) string {
	best, bestDistance := "", 3
	for candidate := range other {
		if distance := editDistance(topic, candidate); distance > 0 && distance < bestDistance {
			best, bestDistance = candidate, distance
		}
	}
	return best
}

func editDistance(a, b string) int {
	if a == b {
		return 0
	}
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur := make([]int, len(b)+1)
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
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

var collectionCall = regexp.MustCompile(`\.(?:Collection|collection|get_collection)\(\s*["']([A-Za-z_][\w.-]*)["']`)

// extractCollections lists a document database's collections from the calls
// that open them, and which files use each.
func (d *detection) extractCollections() {
	for _, p := range d.proposals {
		if p.Category != "database" || p.Subtype != "document" {
			continue
		}
		users := map[string]map[string]string{}
		for _, edge := range append([]Edge(nil), p.Edges...) {
			if edge.Kind != "USES" && edge.Kind != "IMPLEMENTS" {
				continue
			}
			file := d.files[edge.FileID]
			source := d.in.ReadSource(file.RelPath)
			for _, m := range collectionCall.FindAllSubmatchIndex(source, -1) {
				name := string(source[m[2]:m[3]])
				if users[name] == nil {
					users[name] = map[string]string{}
				}
				if _, ok := users[name][file.RelPath]; !ok {
					users[name][file.RelPath] = ref(file.RelPath, lineAt(source, m[0]))
				}
			}
		}
		var names []string
		for name := range users {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			p.Contents = append(p.Contents, Content{Kind: "collection", Name: name,
				Detail: map[string]any{"users": sortedKeys(users[name])}, Evidence: firstValue(users[name])})
		}
	}
}
