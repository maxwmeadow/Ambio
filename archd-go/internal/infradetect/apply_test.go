package infradetect

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
)

func harborDB(t *testing.T) (*sql.DB, Result) {
	t.Helper()
	result, _ := harborResult(t)
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "harbor"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range result.Proposals {
		for _, e := range p.Edges {
			if !seen[e.FileID] {
				seen[e.FileID] = true
				if err := db.UpsertFile(sqlDB, db.File{ID: e.FileID, RootID: "root", Path: e.FileID, RelPath: e.FileID, Language: "typescript"}); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	return sqlDB, result
}

func nodeFor(t *testing.T, sqlDB *sql.DB, service string) *db.InfraNode {
	t.Helper()
	nodes, _ := db.GetInfraNodes(sqlDB, "ws")
	for i := range nodes {
		if nodes[i].Service == service {
			return &nodes[i]
		}
	}
	return nil
}

func TestDetectionProposesThenRespectsDecisions(t *testing.T) {
	sqlDB, result := harborDB(t)
	if _, err := Apply(sqlDB, "ws", "root", result); err != nil {
		t.Fatal(err)
	}
	pg := nodeFor(t, sqlDB, "postgresql/postgres")
	if pg == nil || pg.Status != "proposed" {
		t.Fatalf("detection proposes, it does not assert: %+v", pg)
	}
	edges, _ := db.GetInfraEdges(sqlDB, "ws")
	for _, e := range edges {
		if e.Status != "proposed" {
			t.Fatalf("relationships into a proposal are proposals: %+v", e)
		}
	}

	// The person dismisses PostHog and confirms Postgres; the agent records
	// that the queue also runs on a Redis cluster in production.
	posthog := nodeFor(t, sqlDB, "posthog/observability")
	posthog.Status = "dismissed"
	_ = db.UpsertInfraNode(sqlDB, posthog)
	pg.Status = "confirmed"
	_ = db.UpsertInfraNode(sqlDB, pg)
	queue := nodeFor(t, sqlDB, "bullmq/bullmq")
	queue.Implementations = mergeImplementations(queue.Implementations, nil)
	var impls []map[string]any
	_ = json.Unmarshal(queue.Implementations, &impls)
	impls = append(impls, map[string]any{"environment": "production", "kind": "vendor", "ref": "elasticache", "source": "agent"})
	queue.Implementations, _ = json.Marshal(impls)
	_ = db.UpsertInfraNode(sqlDB, queue)

	if _, err := Apply(sqlDB, "ws", "root", result); err != nil {
		t.Fatal(err)
	}
	if n := nodeFor(t, sqlDB, "posthog/observability"); n == nil || n.Status != "dismissed" {
		t.Errorf("a dismissal sticks across detection runs: %+v", n)
	}
	edges, _ = db.GetInfraEdges(sqlDB, "ws")
	for _, e := range edges {
		if e.Dst == pg.ID && e.Status != "confirmed" {
			t.Errorf("imports into an accepted node are facts: %+v", e)
		}
	}
	if q := nodeFor(t, sqlDB, "bullmq/bullmq"); !strings.Contains(string(q.Implementations), "elasticache") {
		t.Errorf("the agent's implementation survives re-detection: %s", q.Implementations)
	}

	// The project drops OpenAI: the adapter and its stand-in are deleted.
	var trimmed Result
	for _, p := range result.Proposals {
		if p.Service != "openai/api" {
			trimmed.Proposals = append(trimmed.Proposals, p)
		}
	}
	changes, err := Apply(sqlDB, "ws", "root", trimmed)
	if err != nil {
		t.Fatal(err)
	}
	if nodeFor(t, sqlDB, "openai/api") != nil || len(changes.Removed) != 1 {
		t.Errorf("a proposal whose evidence is gone is withdrawn: %+v", changes.Removed)
	}
	pg.Status = "confirmed"
	var noPostgres Result
	for _, p := range trimmed.Proposals {
		if p.Service != "postgresql/postgres" {
			noPostgres.Proposals = append(noPostgres.Proposals, p)
		}
	}
	if _, err := Apply(sqlDB, "ws", "root", noPostgres); err != nil {
		t.Fatal(err)
	}
	if nodeFor(t, sqlDB, "postgresql/postgres") == nil {
		t.Error("a node someone accepted is never deleted by detection")
	}
}

func TestAWorktreeNeverErasesAnotherWorktreesFindings(t *testing.T) {
	sqlDB, result := harborDB(t)
	if _, err := Apply(sqlDB, "ws", "root", result); err != nil {
		t.Fatal(err)
	}
	before, _ := db.GetInfraEdges(sqlDB, "ws")
	// A second worktree of the project with nothing indexed yet.
	if err := db.UpsertRoot(sqlDB, db.Root{ID: "feature", WorkspaceID: "ws", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(sqlDB, "ws", "feature", Result{}); err != nil {
		t.Fatal(err)
	}
	after, _ := db.GetInfraEdges(sqlDB, "ws")
	if len(after) != len(before) || nodeFor(t, sqlDB, "postgresql/postgres") == nil {
		t.Fatalf("the first worktree's %d relationships must survive; %d left", len(before), len(after))
	}
}

// A file that stops writing a table loses that edge and keeps the rest.
func TestItemEdgesFollowTheCode(t *testing.T) {
	sqlDB, result := harborDB(t)
	if _, err := Apply(sqlDB, "ws", "root", result); err != nil {
		t.Fatal(err)
	}
	count := func(kind, item string) int {
		edges, _ := db.GetInfraEdges(sqlDB, "ws")
		n := 0
		for _, e := range edges {
			if e.DependencyType == kind && e.TargetItem == item {
				n++
			}
		}
		return n
	}
	if count("WRITES", "bookings") == 0 || count("PUBLISHES", "booking.reminder") == 0 {
		t.Fatal("item edges are stored with their item")
	}
	trimmed := result
	trimmed.Proposals = nil
	for _, p := range result.Proposals {
		var edges []Edge
		for _, e := range p.Edges {
			if !(e.Kind == "WRITES" && e.Item == "bookings") {
				edges = append(edges, e)
			}
		}
		p.Edges = edges
		trimmed.Proposals = append(trimmed.Proposals, p)
	}
	if _, err := Apply(sqlDB, "ws", "root", trimmed); err != nil {
		t.Fatal(err)
	}
	if count("WRITES", "bookings") != 0 {
		t.Error("a write the code no longer makes is withdrawn")
	}
	if count("WRITES", "customers") == 0 || count("USES", "") == 0 {
		t.Error("other edges survive")
	}
}
