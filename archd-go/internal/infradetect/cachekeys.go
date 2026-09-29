package infradetect

import (
	"regexp"
	"sort"
	"strings"
)

// A cache key: a literal, a template (`cart:${userId}` → cart:{}), a
// "prefix:" + id concatenation, or a constant.
const keyExpr = "(`[^`\\n]+`|'[^'\\n]+'(?:\\s*\\+\\s*[\\w.]+)?|\"[^\"\\n]+\"(?:\\s*\\+\\s*[\\w.]+)?|f\"[^\"\\n]+\"|f'[^'\\n]+'|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)"

// Calls on something named like a cache. Hono's c.get('userId') and a Map's
// get() are not cache reads, so the receiver's name matters.
const cacheReceiver = `\b(?:cache|redis|rdb|kv|client|store|memcached|r)\.`

var cacheKeyPatterns = []struct {
	re   *regexp.Regexp
	kind string
}{
	{regexp.MustCompile(`(?i)` + cacheReceiver + `(?:get|mget|hget|hgetall|exists|ttl)\s*(?:<[^()\n]*>)?\(\s*(?:ctx,\s*)?` + keyExpr), "READS"},
	{regexp.MustCompile(`(?i)` + cacheReceiver + `(?:set|setex|setnx|hset|mset|incr|expire)\s*(?:<[^()\n]*>)?\(\s*(?:ctx,\s*)?` + keyExpr), "WRITES"},
	{regexp.MustCompile(`(?i)` + cacheReceiver + `(?:del|delete|unlink|invalidate|evict|remove)\s*(?:<[^()\n]*>)?\(\s*(?:ctx,\s*)?` + keyExpr), "INVALIDATES"},
}

var templateHole = regexp.MustCompile(`\$\{[^}]*\}|\{[^}]*\}`)

// extractCacheKeys records the key patterns a cache holds and who reads,
// writes and invalidates each. A key that is invalidated but never read or
// written usually means the invalidation misses: restock() deleting "catalog"
// while every read uses "catalog:all" leaves the catalog stale.
func (d *detection) extractCacheKeys() {
	for _, c := range d.proposals {
		if c.Category != "cache" {
			continue
		}
		byKey := map[string]map[string]map[string]string{} // key → kind → file → evidence
		type seenKey struct{ file, kind, key string }
		seen := map[seenKey]bool{}
		visited := map[string]bool{}
		for _, edge := range append([]Edge(nil), c.Edges...) {
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
				for _, m := range constantDecl.FindAllSubmatch(body, -1) {
					constants[string(m[1])] = string(m[2])
				}
			}
			for _, pattern := range cacheKeyPatterns {
				for _, m := range pattern.re.FindAllSubmatchIndex(source, -1) {
					key := normalizeKey(string(source[m[2]:m[3]]), constants)
					if key == "" {
						continue
					}
					if byKey[key] == nil {
						byKey[key] = map[string]map[string]string{}
					}
					if byKey[key][pattern.kind] == nil {
						byKey[key][pattern.kind] = map[string]string{}
					}
					evidence := ref(file.RelPath, lineAt(source, m[0]))
					if _, ok := byKey[key][pattern.kind][file.RelPath]; !ok {
						byKey[key][pattern.kind][file.RelPath] = evidence
					}
					k := seenKey{edge.FileID, pattern.kind, key}
					if !seen[k] {
						seen[k] = true
						c.Edges = append(c.Edges, Edge{FileID: edge.FileID, Kind: pattern.kind, Item: key, Evidence: evidence})
					}
				}
			}
		}
		keys := make([]string, 0, len(byKey))
		for key := range byKey {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			kinds := byKey[key]
			detail := map[string]any{
				"readers":      sortedKeys(kinds["READS"]),
				"writers":      sortedKeys(kinds["WRITES"]),
				"invalidators": sortedKeys(kinds["INVALIDATES"]),
			}
			if len(kinds["INVALIDATES"]) > 0 && len(kinds["READS"]) == 0 && len(kinds["WRITES"]) == 0 {
				detail["warning"] = "invalidated, but nothing reads or writes this key"
				for _, other := range keys {
					if other != key && (strings.HasPrefix(other, key) || strings.HasPrefix(key, other)) && len(byKey[other]["READS"]) > 0 {
						detail["warning"] = "invalidated, but reads use \"" + other + "\" - the entry stays stale"
						detail["similar"] = other
						break
					}
				}
			}
			evidence := firstValue(kinds["WRITES"])
			if evidence == "" {
				evidence = firstValue(kinds["READS"])
			}
			if evidence == "" {
				evidence = firstValue(kinds["INVALIDATES"])
			}
			c.Contents = append(c.Contents, Content{Kind: "key_pattern", Name: key, Detail: detail, Evidence: evidence})
		}
		sortProposal(c)
	}
}

// normalizeKey turns a key expression into a pattern: literals as written,
// template holes and concatenated ids as {}.
func normalizeKey(expr string, constants map[string]string) string {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return ""
	}
	if strings.HasPrefix(expr, "f\"") || strings.HasPrefix(expr, "f'") {
		expr = expr[1:]
	}
	switch expr[0] {
	case '`', '\'', '"':
		quote := expr[0]
		end := strings.IndexByte(expr[1:], quote)
		if end < 0 {
			return ""
		}
		literal := expr[1 : end+1]
		rest := strings.TrimSpace(expr[end+2:])
		literal = templateHole.ReplaceAllString(literal, "{}")
		if strings.HasPrefix(rest, "+") {
			literal += "{}"
		}
		return literal
	}
	if value, ok := constants[expr[strings.LastIndex(expr, ".")+1:]]; ok {
		return templateHole.ReplaceAllString(value, "{}")
	}
	return ""
}

// Flag keys a flags service evaluates, and models an LLM is called with -
// contents that say what the code relies on (a renamed flag, a retired model).
var (
	flagCall  = regexp.MustCompile(`(?:\.variation|\.boolVariation|\.isEnabled|\bisEnabled|\bisFeatureEnabled|\.isOn|\.getFeatureValue|\.getValue|\bflag|\bfeature)\s*\(\s*` + keyExpr)
	modelName = regexp.MustCompile(`\bmodel\s*[:=]\s*["']([\w.:/-]+)["']`)
)

func (d *detection) extractFlagsAndModels() {
	for _, p := range d.proposals {
		var pattern *regexp.Regexp
		kind := ""
		switch p.Category {
		case "flags":
			pattern, kind = flagCall, "flag"
		case "llm":
			pattern, kind = modelName, "model"
		default:
			continue
		}
		users := map[string]map[string]string{}
		visited := map[string]bool{}
		for _, edge := range p.Edges {
			if (edge.Kind != "USES" && edge.Kind != "IMPLEMENTS") || visited[edge.FileID] {
				continue
			}
			visited[edge.FileID] = true
			file := d.files[edge.FileID]
			source := d.in.ReadSource(file.RelPath)
			for _, m := range pattern.FindAllSubmatchIndex(source, -1) {
				name := string(source[m[2]:m[3]])
				if kind == "flag" {
					name = normalizeKey(name, nil)
				}
				if name == "" || strings.Contains(name, "{}") {
					continue
				}
				if users[name] == nil {
					users[name] = map[string]string{}
				}
				if _, ok := users[name][file.RelPath]; !ok {
					users[name][file.RelPath] = ref(file.RelPath, lineAt(source, m[0]))
				}
			}
		}
		names := make([]string, 0, len(users))
		for name := range users {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			p.Contents = append(p.Contents, Content{Kind: kind, Name: name,
				Detail: map[string]any{"users": sortedKeys(users[name])}, Evidence: firstValue(users[name])})
		}
	}
}
