// Case endpoints: the structure of an investigation.
//
//	POST /api/investigation/hypothesis {workspaceId, text, file?, symbol?}
//	POST /api/investigation/verdict    {workspaceId, hypothesis, result, text?, run?}
//	POST /api/investigation/run        {workspaceId, command, watch?, cwd?, timeoutSec?, hypothesis?}
//	POST /api/investigation/conclude   {workspaceId, rootCause, file?, symbol?, fix?, verified?}
//	POST /api/investigation/message    {workspaceId, text, fileId?, symbol?}   (the human)
//	GET  /api/investigation/case?workspace=
//	GET  /api/investigation/pending?workspace=                               (the agent)
//
// Agent-facing responses carry `humanMessages`: whatever the person watching
// has said since the agent's last call. That is how the human reaches an agent
// in any MCP client, because every client shows the agent its tool results.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/runtime"
)

func (s *Server) registerCaseRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/investigation/hypothesis", s.handleCaseHypothesis)
	mux.HandleFunc("/api/investigation/verdict", s.handleCaseVerdict)
	mux.HandleFunc("/api/investigation/run", s.handleCaseRun)
	mux.HandleFunc("/api/investigation/conclude", s.handleCaseConclude)
	mux.HandleFunc("/api/investigation/message", s.handleCaseMessage)
	mux.HandleFunc("/api/investigation/case", s.handleCaseState)
	mux.HandleFunc("/api/investigation/pending", s.handleCasePending)
}

// ensureCase opens a case when an agent goes straight to a hypothesis or a
// run. Refusing would only cost it a turn; the name can be corrected later.
func (s *Server) ensureCase(workspaceID, name string) (opened bool) {
	if s.runtime.ActiveInvestigation(workspaceID) != nil {
		return false
	}
	if inv := s.runtime.AdoptAutoInvestigation(workspaceID, name, "agent"); inv != nil {
		return false
	}
	commit, branch := s.gitInfo(workspaceID)
	s.runtime.StartInvestigation(workspaceID, name, commit, branch, "agent")
	return true
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return false
	}
	limitBody(w, r)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		jsonError(w, "bad request: "+err.Error(), 400)
		return false
	}
	return true
}

// ─── anchors ──────────────────────────────────────────────────────────────────

var (
	pathToken   = regexp.MustCompile(`[\w@.\-/\\]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|java|kt|cs|rb|php|swift|cpp|cc|c|h|hpp)\b`)
	callToken   = regexp.MustCompile("([A-Za-z_$][\\w$]*)\\(")
	tickedToken = regexp.MustCompile("`([A-Za-z_$][\\w$.]*)`")
	// Identifiers written in prose without parentheses: camelCase, PascalCase
	// with an inner capital, or snake_case. Plain words never match.
	identToken = regexp.MustCompile(`\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b`)
)

// resolveFileRef finds a file by id, exact relative path, path suffix, or a
// unique base name.
func (idx *fileIndex) resolveFileRef(ref string) (db.File, bool) {
	ref = filepath.ToSlash(strings.TrimSpace(ref))
	ref = strings.TrimPrefix(ref, "./")
	if ref == "" {
		return db.File{}, false
	}
	if f, ok := idx.byRel[ref]; ok {
		return f, true
	}
	if f, ok := idx.byAbs[normAbs(ref)]; ok {
		return f, true
	}
	for _, f := range idx.byRel {
		if f.ID == ref {
			return f, true
		}
	}
	var suffix []db.File
	for rel, f := range idx.byRel {
		if strings.HasSuffix(rel, "/"+ref) {
			suffix = append(suffix, f)
		}
	}
	if len(suffix) == 1 {
		return suffix[0], true
	}
	if list := idx.byBase[strings.ToLower(filepath.Base(ref))]; len(list) == 1 {
		return list[0], true
	}
	return db.File{}, false
}

type symbolHit struct {
	file db.File
	name string
	kind string
	line int
	end  int
}

func (s *Server) symbolsNamed(sqlDB *sql.DB, idx *fileIndex, names []string) map[string][]symbolHit {
	out := map[string][]symbolHit{}
	if len(names) == 0 {
		return out
	}
	byID := map[string]db.File{}
	for _, f := range idx.byRel {
		byID[f.ID] = f
	}
	holders := strings.TrimRight(strings.Repeat("?,", len(names)), ",")
	args := make([]any, len(names))
	for i, n := range names {
		args[i] = n
	}
	rows, err := sqlDB.Query(`SELECT file_id, name, kind, line_start, line_end FROM symbols WHERE name IN (`+holders+`)`, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var h symbolHit
		var fileID string
		if rows.Scan(&fileID, &h.name, &h.kind, &h.line, &h.end) != nil {
			continue
		}
		f, ok := byID[fileID]
		if !ok {
			continue
		}
		h.file = f
		out[h.name] = append(out[h.name], h)
	}
	return out
}

func callable(kind string) bool { return kind == "function" || kind == "method" }

// anchorsFor combines an explicit file/symbol with whatever the text names.
// Every note in our agent trials named its file or function in prose, so the
// map can light up without the agent learning a parameter.
func (s *Server) anchorsFor(workspaceID, text, fileRef, symbol string) []runtime.Anchor {
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		return nil
	}
	idx, err := s.loadFileIndex(sqlDB, workspaceID)
	if err != nil {
		return nil
	}
	var out []runtime.Anchor
	seen := map[string]bool{}
	add := func(a runtime.Anchor) {
		k := a.FileID + "#" + a.Symbol
		if a.FileID == "" || seen[k] || len(out) >= 4 {
			return
		}
		// A symbol anchor makes a bare file anchor for the same file redundant.
		if a.Symbol != "" && seen[a.FileID+"#"] {
			for i := range out {
				if out[i].FileID == a.FileID && out[i].Symbol == "" {
					out[i] = a
					seen[k] = true
					return
				}
			}
		}
		if a.Symbol == "" {
			for _, o := range out {
				if o.FileID == a.FileID {
					return
				}
			}
		}
		seen[k] = true
		out = append(out, a)
	}

	mentionedFiles := map[string]bool{}
	if fileRef != "" {
		if f, ok := idx.resolveFileRef(fileRef); ok {
			mentionedFiles[f.ID] = true
			add(runtime.Anchor{FileID: f.ID, RelPath: f.RelPath})
		}
	}
	for _, tok := range pathToken.FindAllString(text, -1) {
		if f, ok := idx.resolveFileRef(tok); ok {
			mentionedFiles[f.ID] = true
			add(runtime.Anchor{FileID: f.ID, RelPath: f.RelPath})
		}
	}

	var names []string
	nameSet := map[string]bool{}
	pushName := func(n string) {
		if i := strings.LastIndex(n, "."); i >= 0 {
			n = n[i+1:]
		}
		if len(n) < 3 || nameSet[n] || commonWord[strings.ToLower(n)] {
			return
		}
		nameSet[n] = true
		names = append(names, n)
	}
	if symbol != "" {
		pushName(symbol)
	}
	for _, m := range callToken.FindAllStringSubmatch(text, -1) {
		pushName(m[1])
	}
	for _, m := range tickedToken.FindAllStringSubmatch(text, -1) {
		pushName(m[1])
	}
	for _, m := range identToken.FindAllString(text, -1) {
		pushName(m)
	}
	hits := s.symbolsNamed(sqlDB, idx, names)
	for _, n := range names {
		list := hits[n]
		if len(list) == 0 {
			continue
		}
		// Prefer a definition in a file the text also names, then a unique
		// callable, then a unique anything. Ambiguous names anchor nothing.
		var pick *symbolHit
		for i := range list {
			if mentionedFiles[list[i].file.ID] {
				pick = &list[i]
				break
			}
		}
		if pick == nil {
			var calls []symbolHit
			for _, h := range list {
				if callable(h.kind) {
					calls = append(calls, h)
				}
			}
			if len(calls) == 1 {
				pick = &calls[0]
			} else if len(list) == 1 {
				pick = &list[0]
			}
		}
		if pick != nil {
			add(runtime.Anchor{FileID: pick.file.ID, RelPath: pick.file.RelPath, Symbol: pick.name, Line: pick.line})
		}
	}
	return out
}

// Words that often precede "(" in prose and must never anchor to a symbol
// that happens to share the name.
var commonWord = map[string]bool{
	"the": true, "and": true, "for": true, "not": true, "but": true, "with": true,
	"see": true, "e.g": true, "i.e": true, "call": true, "calls": true, "function": true,
	"return": true, "returns": true, "new": true, "get": true, "set": true, "run": true,
	"test": true, "tests": true, "main": true, "init": true, "index": true, "data": true,
}

// ─── handlers ─────────────────────────────────────────────────────────────────

func (s *Server) respondWithMessages(w http.ResponseWriter, workspaceID string, body map[string]any) {
	if msgs := s.runtime.TakePendingMessages(workspaceID); len(msgs) > 0 {
		body["humanMessages"] = msgs
	}
	jsonOK(w, body)
}

func (s *Server) handleCaseHypothesis(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Text        string `json:"text"`
		File        string `json:"file"`
		Symbol      string `json:"symbol"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	opened := s.ensureCase(body.WorkspaceID, clip(body.Text, 80))
	h, err := s.runtime.AddHypothesis(body.WorkspaceID, body.Text, s.anchorsFor(body.WorkspaceID, body.Text, body.File, body.Symbol))
	if err != nil {
		jsonError(w, err.Error(), 400)
		return
	}
	resp := map[string]any{"hypothesis": h, "openedCase": opened}
	s.respondWithMessages(w, body.WorkspaceID, resp)
}

func (s *Server) handleCaseVerdict(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Hypothesis  string `json:"hypothesis"`
		Result      string `json:"result"`
		Text        string `json:"text"`
		Run         string `json:"run"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	runID := ""
	if c := s.runtime.Case(body.WorkspaceID); c != nil && body.Run != "" {
		for _, run := range c.Runs {
			if run.ID == body.Run || fmt.Sprintf("R%d", run.N) == strings.ToUpper(body.Run) {
				runID = run.ID
			}
		}
	}
	h, err := s.runtime.SetVerdict(body.WorkspaceID, body.Hypothesis, body.Result, body.Text, runID)
	if err != nil {
		code := 400
		if err == runtime.ErrNoCase {
			code = 409
		}
		jsonError(w, err.Error(), code)
		return
	}
	s.respondWithMessages(w, body.WorkspaceID, map[string]any{"hypothesis": h})
}

// runSlots bounds concurrent runs per workspace: an agent looping on run must
// not fork-bomb the machine.
var (
	runSlotsMu sync.Mutex
	runSlots   = map[string]int{}
)

const maxConcurrentRuns = 2

func acquireRunSlot(workspaceID string) bool {
	runSlotsMu.Lock()
	defer runSlotsMu.Unlock()
	if runSlots[workspaceID] >= maxConcurrentRuns {
		return false
	}
	runSlots[workspaceID]++
	return true
}

func releaseRunSlot(workspaceID string) {
	runSlotsMu.Lock()
	defer runSlotsMu.Unlock()
	runSlots[workspaceID]--
}

func (s *Server) handleCaseRun(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string            `json:"workspaceId"`
		Command     string            `json:"command"`
		Watch       []json.RawMessage `json:"watch"`
		Cwd         string            `json:"cwd"`
		TimeoutSec  int               `json:"timeoutSec"`
		Hypothesis  string            `json:"hypothesis"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	body.Command = strings.TrimSpace(body.Command)
	if body.Command == "" {
		jsonError(w, "command is required: the command that reproduces the problem, as you would type it (e.g. `npm test`, `node repro.js`, `pytest tests/test_x.py`)", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	roots, err := db.GetActiveRoots(sqlDB, body.WorkspaceID)
	if err != nil || len(roots) == 0 {
		jsonError(w, "workspace has no active root", 404)
		return
	}
	root := roots[0].Path
	cwd, err := confinedCwd(root, body.Cwd)
	if err != nil {
		jsonError(w, err.Error(), 400)
		return
	}
	idx, err := s.loadFileIndex(sqlDB, body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	watches, err := s.resolveRunWatches(sqlDB, idx, body.Watch)
	if err != nil {
		jsonError(w, err.Error(), 400)
		return
	}
	if !acquireRunSlot(body.WorkspaceID) {
		jsonError(w, fmt.Sprintf("%d runs are already in progress for this workspace; wait for one to finish", maxConcurrentRuns), 429)
		return
	}
	defer releaseRunSlot(body.WorkspaceID)

	opened := s.ensureCase(body.WorkspaceID, "Debugging: "+clip(body.Command, 60))
	hypothesisID := ""
	if body.Hypothesis != "" {
		if c := s.runtime.Case(body.WorkspaceID); c != nil {
			for _, h := range c.Hypotheses {
				if strings.EqualFold(h.ID, body.Hypothesis) || strings.EqualFold(h.ID, "H"+body.Hypothesis) {
					hypothesisID = h.ID
				}
			}
		}
	}
	watchAnchors := make([]runtime.Anchor, 0, len(watches))
	for _, wch := range watches {
		watchAnchors = append(watchAnchors, runtime.Anchor{FileID: wch.FileID, RelPath: wch.RelPath, Symbol: wch.Symbol, Line: wch.LineStart})
	}
	startedAt := time.Now().UnixMilli()
	s.hub.Broadcast("investigation:run_started", map[string]any{
		"workspaceId":  body.WorkspaceID,
		"command":      body.Command,
		"watches":      watchAnchors,
		"hypothesisId": hypothesisID,
		"startedAt":    startedAt,
	})

	timeout := time.Duration(body.TimeoutSec) * time.Second
	outcome, err := s.runtime.RunExperiment(context.Background(), runtime.RunSpec{
		WorkspaceID: body.WorkspaceID,
		Root:        root,
		Cwd:         cwd,
		Command:     body.Command,
		Watches:     watches,
		Timeout:     timeout,
	})
	if err != nil {
		s.hub.Broadcast("investigation:run", map[string]any{
			"workspaceId": body.WorkspaceID,
			"run":         map[string]any{"command": body.Command, "error": err.Error(), "startedAt": startedAt},
		})
		jsonError(w, "could not run the command: "+err.Error(), 500)
		return
	}
	rep := analyzeRun(outcome, watches, idx)
	rep.HypothesisID = hypothesisID
	ref, _ := s.runtime.RecordRun(body.WorkspaceID, runtime.RunRef{
		ID:           rep.ID,
		Command:      rep.Command,
		ExitCode:     rep.ExitCode,
		TimedOut:     rep.TimedOut,
		DurationMs:   rep.DurationMs,
		HypothesisID: hypothesisID,
		Headline:     rep.Headline,
		At:           time.Now().UnixMilli(),
	})
	rep.N = ref.N
	s.hub.Broadcast("investigation:run", map[string]any{
		"workspaceId": body.WorkspaceID,
		"run":         rep,
	})

	resp := map[string]any{
		"run":        rep,
		"report":     renderRunReport(rep, len(watches)),
		"openedCase": opened,
	}
	s.respondWithMessages(w, body.WorkspaceID, resp)
}

// confinedCwd keeps a run inside the workspace: a relative cwd resolves
// against the root, and nothing may escape it.
func confinedCwd(root, cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		return root, nil
	}
	target := cwd
	if !filepath.IsAbs(target) {
		target = filepath.Join(root, target)
	}
	target = filepath.Clean(target)
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("cwd %q is outside the workspace (%s)", cwd, root)
	}
	return target, nil
}

var fileSymbolRef = regexp.MustCompile(`^(.+\.[A-Za-z0-9]+):([A-Za-z_$][\w$.]*)$`)

const maxRunWatches = 24

// resolveRunWatches accepts "path:symbol", "path" (every function in the
// file), a bare "symbol", or {file, symbol}. Anything unresolvable fails the
// run before it starts, with the candidates - a watch that silently matches
// nothing would read as "never called" and mislead.
func (s *Server) resolveRunWatches(sqlDB *sql.DB, idx *fileIndex, raw []json.RawMessage) ([]runtime.RunWatch, error) {
	if len(raw) > maxRunWatches {
		return nil, fmt.Errorf("at most %d watches per run (got %d)", maxRunWatches, len(raw))
	}
	var out []runtime.RunWatch
	for _, item := range raw {
		var fileRef, symbol string
		var str string
		if json.Unmarshal(item, &str) == nil {
			str = strings.TrimSpace(str)
			if m := fileSymbolRef.FindStringSubmatch(str); m != nil {
				fileRef, symbol = m[1], m[2]
			} else if pathToken.MatchString(str) && pathToken.FindString(str) == str {
				fileRef = str
			} else {
				symbol = str
			}
		} else {
			var obj struct {
				File   string `json:"file"`
				Symbol string `json:"symbol"`
			}
			if err := json.Unmarshal(item, &obj); err != nil {
				return nil, fmt.Errorf("watch entries are \"path:function\", \"path\" or {file, symbol}")
			}
			fileRef, symbol = obj.File, obj.Symbol
		}
		if i := strings.LastIndex(symbol, "."); i >= 0 {
			symbol = symbol[i+1:] // Class.method -> method
		}

		if fileRef != "" {
			f, ok := idx.resolveFileRef(fileRef)
			if !ok {
				return nil, fmt.Errorf("watch: file %q is not in the workspace index", fileRef)
			}
			if symbol == "" || symbol == "*" {
				out = append(out, runtime.RunWatch{FileID: f.ID, RelPath: f.RelPath, AbsPath: f.Path, Symbol: "*"})
				continue
			}
			wt, err := s.resolveWatchTarget(workspaceOf(idx, f), f.ID, symbol)
			if err != nil {
				return nil, fmt.Errorf("watch: %v", err)
			}
			out = append(out, runtime.RunWatch{FileID: wt.FileID, RelPath: wt.RelPath, AbsPath: wt.AbsPath,
				Symbol: wt.Symbol, LineStart: wt.LineStart, LineEnd: wt.LineEnd})
			continue
		}

		hits := s.symbolsNamed(sqlDB, idx, []string{symbol})[symbol]
		var calls []symbolHit
		for _, h := range hits {
			if callable(h.kind) {
				calls = append(calls, h)
			}
		}
		if len(calls) == 0 {
			calls = hits
		}
		switch len(calls) {
		case 0:
			return nil, fmt.Errorf("watch: no function named %q in the workspace - use \"path:function\"", symbol)
		case 1:
			h := calls[0]
			out = append(out, runtime.RunWatch{FileID: h.file.ID, RelPath: h.file.RelPath, AbsPath: h.file.Path,
				Symbol: h.name, LineStart: h.line, LineEnd: h.end})
		default:
			cands := make([]string, 0, len(calls))
			for _, h := range calls {
				cands = append(cands, fmt.Sprintf("%s:%s", h.file.RelPath, h.name))
			}
			return nil, fmt.Errorf("watch: %q is ambiguous - pick one of %s", symbol, strings.Join(cands, ", "))
		}
	}
	return out, nil
}

// workspaceOf recovers the workspace id resolveWatchTarget needs. Every file
// in the index belongs to the same workspace, so the root lookup is enough.
func workspaceOf(idx *fileIndex, f db.File) string { return idx.workspaceID }

func (s *Server) handleCaseConclude(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		RootCause   string `json:"rootCause"`
		File        string `json:"file"`
		Symbol      string `json:"symbol"`
		Fix         string `json:"fix"`
		Verified    string `json:"verified"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	c, err := s.runtime.Conclude(body.WorkspaceID, runtime.Conclusion{
		RootCause: body.RootCause,
		Anchors:   s.anchorsFor(body.WorkspaceID, body.RootCause+" "+body.Fix, body.File, body.Symbol),
		Fix:       strings.TrimSpace(body.Fix),
		Verified:  body.Verified,
	})
	if err != nil {
		code := 400
		if err == runtime.ErrNoCase {
			code = 409
		}
		jsonError(w, err.Error(), code)
		return
	}
	s.respondWithMessages(w, body.WorkspaceID, map[string]any{"conclusion": c})
}

// handleCaseMessage is the human's side: a message from the canvas to the
// agent working the case.
func (s *Server) handleCaseMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Text        string `json:"text"`
		FileID      string `json:"fileId"`
		Symbol      string `json:"symbol"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	var anchor *runtime.Anchor
	if body.FileID != "" {
		if sqlDB, err := s.dbFor(body.WorkspaceID); err == nil {
			if f, err := db.GetFileByID(sqlDB, body.FileID); err == nil && f != nil {
				anchor = &runtime.Anchor{FileID: f.ID, RelPath: f.RelPath, Symbol: body.Symbol}
			}
		}
	}
	msg, err := s.runtime.QueueHumanMessage(body.WorkspaceID, body.Text, anchor)
	if err != nil {
		code := 400
		if err == runtime.ErrNoCase {
			code = 409
		}
		jsonError(w, err.Error(), code)
		return
	}
	jsonOK(w, map[string]any{"message": msg})
}

func (s *Server) handleCaseState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	jsonOK(w, map[string]any{"case": s.runtime.Case(r.URL.Query().Get("workspace"))})
}

func (s *Server) handleCasePending(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	ws := r.URL.Query().Get("workspace")
	msgs := s.runtime.TakePendingMessages(ws)
	if msgs == nil {
		msgs = []runtime.HumanMessage{}
	}
	jsonOK(w, map[string]any{"humanMessages": msgs})
}
