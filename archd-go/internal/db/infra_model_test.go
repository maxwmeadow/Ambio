package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
)

func infraWorkspace(t *testing.T) (*sql.DB, *InfraNode) {
	t.Helper()
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "harbor"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"repo", "adapter"} {
		if err := UpsertFile(database, File{ID: id, RootID: "root", Path: id + ".ts", RelPath: id + ".ts", Language: "typescript"}); err != nil {
			t.Fatal(err)
		}
	}
	node := &InfraNode{WorkspaceID: "ws", Name: "Postgres", Category: "database", Provider: "postgresql", Service: "postgresql/postgres"}
	if err := UpsertInfraNode(database, node); err != nil {
		t.Fatal(err)
	}
	return database, node
}

func edge(node *InfraNode, src, kind, item, status string) Dependency {
	return Dependency{WorkspaceID: "ws", Src: src, Dst: node.ID, SrcType: "file", DstType: "infra",
		DependencyType: kind, TargetItem: item, Status: status, CreatedBy: "parser"}
}

func TestOneFileWritingTwoTablesIsTwoRelationships(t *testing.T) {
	database, node := infraWorkspace(t)
	for _, table := range []string{"bookings", "customers", "bookings"} {
		if err := UpsertDependency(database, edge(node, "repo", "WRITES", table, "confirmed")); err != nil {
			t.Fatal(err)
		}
	}
	edges, err := GetInfraEdges(database, "ws")
	if err != nil {
		t.Fatal(err)
	}
	items := map[string]int{}
	for _, e := range edges {
		items[e.TargetItem] = e.Weight
	}
	if len(edges) != 2 || items["bookings"] != 2 || items["customers"] != 1 {
		t.Fatalf("want bookings x2 and customers x1, got %+v", edges)
	}
}

func TestADetectedEdgeNeverOverridesADecision(t *testing.T) {
	database, node := infraWorkspace(t)
	if err := UpsertDependency(database, edge(node, "repo", "USES", "", "dismissed")); err != nil {
		t.Fatal(err)
	}
	if err := UpsertDependency(database, edge(node, "repo", "USES", "", "proposed")); err != nil {
		t.Fatal(err)
	}
	if err := UpsertDependency(database, edge(node, "adapter", "IMPLEMENTS", "", "proposed")); err != nil {
		t.Fatal(err)
	}
	edges, _ := GetInfraEdges(database, "ws")
	status := map[string]string{}
	for _, e := range edges {
		status[e.Src] = e.Status
	}
	if status["repo"] != "dismissed" {
		t.Errorf("re-detection must keep the dismissal, got %q", status["repo"])
	}
	if status["adapter"] != "proposed" {
		t.Errorf("a new detection is a proposal, got %q", status["adapter"])
	}
}

func TestAParserNeverOverwritesWhatTheAgentWroteAboutAnItem(t *testing.T) {
	database, node := infraWorkspace(t)
	agent := &InfraContent{WorkspaceID: "ws", InfraID: node.ID, Kind: "table", Name: "bookings",
		Detail: json.RawMessage(`{"note":"holds expire after 15 minutes"}`), Source: "agent"}
	if err := UpsertInfraContent(database, agent); err != nil {
		t.Fatal(err)
	}
	evidence := "db/migrations/002_bookings.sql:1"
	parser := &InfraContent{WorkspaceID: "ws", InfraID: node.ID, Kind: "table", Name: "bookings",
		Detail: json.RawMessage(`{"columns":["id"]}`), Evidence: &evidence, Source: "parser"}
	if err := UpsertInfraContent(database, parser); err != nil {
		t.Fatal(err)
	}
	contents, err := GetInfraContents(database, "ws")
	if err != nil || len(contents) != 1 {
		t.Fatalf("one item, got %+v %v", contents, err)
	}
	if string(contents[0].Detail) != `{"note":"holds expire after 15 minutes"}` || contents[0].Source != "agent" {
		t.Errorf("the agent's detail and authorship stay: %+v", contents[0])
	}
	if contents[0].Evidence == nil || *contents[0].Evidence != evidence {
		t.Errorf("the parser still contributes evidence: %+v", contents[0].Evidence)
	}
}

func TestRequirementsKeepNamesAndTheirNode(t *testing.T) {
	database, node := infraWorkspace(t)
	evidence := "src/config/env.ts:4"
	if err := UpsertInfraRequirement(database, &InfraRequirement{WorkspaceID: "ws", Name: "DATABASE_URL", InfraID: &node.ID, Evidence: &evidence}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertInfraRequirement(database, &InfraRequirement{WorkspaceID: "ws", Name: "DATABASE_URL", Present: true}); err != nil {
		t.Fatal(err)
	}
	reqs, err := GetInfraRequirements(database, "ws")
	if err != nil || len(reqs) != 1 {
		t.Fatalf("%+v %v", reqs, err)
	}
	if reqs[0].InfraID == nil || *reqs[0].InfraID != node.ID || !reqs[0].Present {
		t.Errorf("the tie to Postgres survives, presence updates: %+v", reqs[0])
	}
}

func TestAnOlderDatabaseGainsItemLevelEdges(t *testing.T) {
	database, node := infraWorkspace(t)
	// Put dependencies back the way older databases have them.
	ctx := context.Background()
	conn, _ := database.Conn(ctx)
	for _, stmt := range []string{
		`DROP INDEX dependencies_unique_item`,
		`CREATE UNIQUE INDEX dependencies_unique ON dependencies(src, dst, dependency_type)`,
		`UPDATE infra_nodes SET category = 'cdn' WHERE id = '` + node.ID + `'`,
	} {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	_ = conn.Close()
	if err := migrate(database); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"bookings", "customers"} {
		if err := UpsertDependency(database, edge(node, "repo", "WRITES", table, "confirmed")); err != nil {
			t.Fatalf("after migrating, a second table is a second edge: %v", err)
		}
	}
	if n, _ := GetInfraNode(database, node.ID); n.Category != "platform" || n.Subtype != "cdn" {
		t.Errorf("a stored cdn node becomes a platform: %+v", n)
	}
}

func TestHostingASystemInAPlatformIsADeployment(t *testing.T) {
	database, _ := infraWorkspace(t)
	platform := &InfraNode{WorkspaceID: "ws", Name: "Vercel", Category: "platform", Provider: "vercel", Service: "vercel/platform"}
	if err := UpsertInfraNode(database, platform); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(database, System{ID: "web", WorkspaceID: "ws", Name: "Web", Source: "agent"}); err != nil {
		t.Fatal(err)
	}
	// An agent separately recorded that the worker deploys there too.
	if err := UpsertSystem(database, System{ID: "worker", WorkspaceID: "ws", Name: "Worker", Source: "agent"}); err != nil {
		t.Fatal(err)
	}
	agentEdge := Dependency{WorkspaceID: "ws", Src: "worker", Dst: platform.ID, SrcType: "system", DstType: "infra", DependencyType: "DEPLOYS_TO", CreatedBy: "agent"}
	if err := UpsertDependency(database, agentEdge); err != nil {
		t.Fatal(err)
	}
	place := func(parent *string, parentType *string, kind string) {
		t.Helper()
		if _, err := ApplyFloorLayoutBatch(database, "ws", []FloorLayout{{
			WorkspaceID: "ws", NodeID: "web", NodeType: "system", ParentNodeID: parent, ParentNodeType: parentType,
			ContainmentKind: kind, Width: 620, Height: 420, Scale: 1, InteriorScale: 1,
		}}); err != nil {
			t.Fatal(err)
		}
	}
	deploys := func() map[string]bool {
		out := map[string]bool{}
		edges, _ := GetInfraEdges(database, "ws")
		for _, e := range edges {
			if e.DependencyType == "DEPLOYS_TO" {
				out[e.Src] = true
			}
		}
		return out
	}

	infraType := "infra"
	place(&platform.ID, &infraType, "hosted_by")
	if _, _, err := ReconcileHostingEdges(database, "ws"); err != nil {
		t.Fatal(err)
	}
	if got := deploys(); !got["web"] || !got["worker"] {
		t.Fatalf("web is hosted, so it deploys there; worker's edge stays: %v", got)
	}

	place(nil, nil, "root")
	if _, removed, err := ReconcileHostingEdges(database, "ws"); err != nil || len(removed) != 1 {
		t.Fatalf("moving web out withdraws exactly its canvas edge: %v %v", removed, err)
	}
	if got := deploys(); got["web"] || !got["worker"] {
		t.Fatalf("the agent's record is never withdrawn by the canvas: %v", got)
	}
}

func TestReindexingAFileKeepsItsInfraRelationships(t *testing.T) {
	database, node := infraWorkspace(t)
	agentEdge := edge(node, "repo", "WRITES", "bookings", "confirmed")
	agentEdge.CreatedBy = "agent"
	importEdge := Dependency{WorkspaceID: "ws", Src: "repo", Dst: "adapter", SrcType: "file", DstType: "file", DependencyType: "IMPORTS", CreatedBy: "parser"}
	for _, dep := range []Dependency{agentEdge, importEdge} {
		if err := UpsertDependency(database, dep); err != nil {
			t.Fatal(err)
		}
	}
	// What the indexer does before rebuilding a saved file's imports.
	if err := DeleteOutgoingDependenciesByFile(database, "repo"); err != nil {
		t.Fatal(err)
	}
	edges, _ := GetInfraEdges(database, "ws")
	if len(edges) != 1 {
		t.Fatalf("saving repo.ts must not erase what it writes: %+v", edges)
	}
	all, _ := GetDependencies(database, "ws")
	for _, d := range all {
		if d.DependencyType == "IMPORTS" {
			t.Fatalf("the parser's import is rebuilt from the parse, so it is cleared: %+v", d)
		}
	}
}
