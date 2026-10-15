package parser

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"path"
	"regexp"
	"strings"

	"ambio.local/archd/internal/db"
)

// Stylesheets (CSS, SCSS, Sass, Less) are source: a UI system owns them and
// other files load them. They are read from the text, like the languages in
// imports_more.go; there is no call graph to walk.
//
//	css:path:<dir>|<spec>  a stylesheet (or, for @config, a script) named from
//	                       dir; the indexer tries the spellings Sass and Less
//	                       allow (no extension, a leading underscore, _index)

const ImportStylesheetPath = "css:path:"

var stylesheetExts = map[string]string{
	".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less",
}

// IsStylesheet reports whether a path is a stylesheet the indexer reads.
func IsStylesheet(filePath string) bool {
	_, ok := stylesheetExts[strings.ToLower(path.Ext(strings.ReplaceAll(filePath, "\\", "/")))]
	return ok
}

func isStylesheetLanguage(lang string) bool {
	switch lang {
	case "css", "scss", "sass", "less":
		return true
	}
	return false
}

var (
	// @import "a", "b";  @use "x" as y;  @forward "z";  and Tailwind's
	// @reference "../app.css" and @config "./tailwind.config.js".
	stylesheetAtRuleRe = regexp.MustCompile(`(?m)@(import|use|forward|reference|config)\b([^;\n{]*)`)
	stylesheetQuotedRe = regexp.MustCompile(`["']([^"']+)["']`)
	stylesheetURLRe    = regexp.MustCompile(`url\(\s*([^"')\s]+)\s*\)`)
	// CSS Modules: composes: button from "./base.module.css";  @value x from "./tokens.css";
	stylesheetFromRe       = regexp.MustCompile(`(?m)(?:composes\s*:|@value\b)[^;\n{}]*\bfrom\s+["']([^"']+)["']`)
	stylesheetLineNoteRe   = regexp.MustCompile(`(?m)^\s*//.*$`)
	stylesheetDefinitionRe = regexp.MustCompile(`(?m)^[ \t]*@(mixin|function)\s+([\w-]+)`)
	stylesheetSassMixinRe  = regexp.MustCompile(`(?m)^=([\w-]+)`)
)

// parseStylesheet fills in what a stylesheet contributes: the files it loads,
// and the mixins and functions it defines.
func parseStylesheet(src []byte, lang, relPath string, result *Result) {
	text := blockCommentRe.ReplaceAllStringFunc(string(src), blankKeepingLines)
	if lang != "css" {
		text = stylesheetLineNoteRe.ReplaceAllString(text, "")
	}
	result.Imports = stylesheetImports(text, relPath)
	if lang != "css" {
		result.Symbols = stylesheetSymbols(text, lang)
	}
}

func blankKeepingLines(comment string) string {
	return strings.Repeat("\n", strings.Count(comment, "\n"))
}

func stylesheetImports(text, relPath string) []string {
	dir := path.Dir(relPath)
	var specs []string
	seen := map[string]bool{}
	add := func(spec string) {
		spec = strings.TrimSpace(spec)
		if !localStylesheetSpec(spec) {
			return
		}
		key := ImportStylesheetPath + dir + "|" + spec
		if !seen[key] {
			seen[key] = true
			specs = append(specs, key)
		}
	}
	for _, match := range stylesheetAtRuleRe.FindAllStringSubmatch(text, -1) {
		rule, rest := match[1], match[2]
		quoted := stylesheetQuotedRe.FindAllStringSubmatch(rest, -1)
		if rule != "import" && len(quoted) > 1 {
			quoted = quoted[:1] // @use "x" with ($font: "Inter") names one file
		}
		for _, name := range quoted {
			add(name[1])
		}
		if len(quoted) == 0 {
			if bare := stylesheetURLRe.FindStringSubmatch(rest); bare != nil {
				add(bare[1])
			}
		}
	}
	for _, match := range stylesheetFromRe.FindAllStringSubmatch(text, -1) {
		add(match[1])
	}
	return specs
}

// localStylesheetSpec drops what can never be a project file: URLs, Sass's
// built-in modules, webpack's ~package form and interpolated names. A bare
// package name ("tailwindcss") is kept; it resolves to nothing unless a file
// by that name sits beside the stylesheet, which is what CSS means by it.
func localStylesheetSpec(spec string) bool {
	if spec == "" || strings.Contains(spec, "#{") || strings.Contains(spec, "://") {
		return false
	}
	for _, prefix := range []string{"//", "/", "~", "@", "sass:", "data:", "http:", "https:"} {
		if strings.HasPrefix(spec, prefix) {
			return false
		}
	}
	return true
}

// stylesheetSymbols lists the mixins and functions a Sass or Less file
// defines. Rules and selectors are not symbols: nothing calls them by name.
func stylesheetSymbols(text, lang string) []db.Symbol {
	src := []byte(text)
	var symbols []db.Symbol
	record := func(name string, start, nameEnd int) {
		end := definitionEnd(src, nameEnd)
		sum := sha256.Sum256(src[start:end])
		symbols = append(symbols, db.Symbol{
			Name:      name,
			Kind:      "function",
			LineStart: bytes.Count(src[:start], []byte("\n")) + 1,
			LineEnd:   bytes.Count(src[:end], []byte("\n")) + 1,
			BodyHash:  hex.EncodeToString(sum[:]),
		})
	}
	for _, m := range stylesheetDefinitionRe.FindAllSubmatchIndex(src, -1) {
		record(string(src[m[4]:m[5]]), m[0], m[1])
	}
	if lang == "sass" {
		for _, m := range stylesheetSassMixinRe.FindAllSubmatchIndex(src, -1) {
			record(string(src[m[2]:m[3]]), m[0], m[1])
		}
	}
	return symbols
}

// definitionEnd is the byte after a definition's closing brace, or the end of
// its line when it has no braces (the indented Sass syntax).
func definitionEnd(src []byte, from int) int {
	depth := 0
	for i := from; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i + 1
			}
		case '\n':
			if depth == 0 {
				return i
			}
		}
	}
	return len(src)
}
