package infradetect

import (
	"database/sql"
	"testing"

	"ambio.local/archd/internal/db"
)

func applyFixture(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	for _, step := range []error{
		db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}),
		db.UpsertRoot(sqlDB, db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}),
		db.UpsertFile(sqlDB, db.File{ID: "cart", RootID: "root", Path: "/s/cart.ts", RelPath: "cart.ts", Language: "typescript"}),
		db.UpsertFile(sqlDB, db.File{ID: "order", RootID: "root", Path: "/s/order.ts", RelPath: "order.ts", Language: "typescript"}),
	} {
		if step != nil {
			t.Fatal(step)
		}
	}
	return sqlDB
}

func redis(edges ...Edge) Result {
	return Result{Proposals: []Proposal{{
		Service: "redis/redis", Name: "Redis", Category: "cache", Provider: "redis", Edges: edges,
	}}}
}

// Apply reports what is new or gone since the last run - what Review Changes
// turns into "Cart now writes to Redis" - and keeps people's decisions.
func TestApplyReportsNewAndWithdrawnLinksAndKeepsDecisions(t *testing.T) {
	sqlDB := applyFixture(t)
	writes := Edge{FileID: "cart", Kind: "WRITES", Item: "cart:*", Evidence: "cart.ts:3"}
	reads := Edge{FileID: "order", Kind: "READS", Item: "cart:*", Evidence: "order.ts:9"}

	first, err := Apply(sqlDB, "ws", "root", redis(writes))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Upserted) != 1 || first.Upserted[0].Status != "proposed" || len(first.Linked) != 1 || len(first.Unlinked) != 0 {
		t.Fatalf("first run = %+v", first)
	}

	again, err := Apply(sqlDB, "ws", "root", redis(writes))
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Linked) != 0 || len(again.Unlinked) != 0 {
		t.Fatalf("an unchanged run reported changes: linked %d, unlinked %d", len(again.Linked), len(again.Unlinked))
	}

	moved, err := Apply(sqlDB, "ws", "root", redis(reads))
	if err != nil {
		t.Fatal(err)
	}
	if len(moved.Linked) != 1 || moved.Linked[0].Src != "order" || len(moved.Unlinked) != 1 || moved.Unlinked[0].Src != "cart" {
		t.Fatalf("moved = linked %+v unlinked %+v", moved.Linked, moved.Unlinked)
	}
	edges, _ := db.GetInfraEdges(sqlDB, "ws")
	if len(edges) != 1 || edges[0].Src != "order" {
		t.Fatalf("stored edges = %+v", edges)
	}

	// Dismissed infrastructure is never proposed again.
	node := first.Upserted[0]
	if err := db.UpdateInfraStatus(sqlDB, node.ID, "dismissed"); err != nil {
		t.Fatal(err)
	}
	after, err := Apply(sqlDB, "ws", "root", redis(reads))
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Upserted) != 0 {
		t.Fatalf("a dismissed node was proposed again: %+v", after.Upserted)
	}
	nodes, _ := db.GetInfraNodes(sqlDB, "ws")
	if len(nodes) != 1 || nodes[0].Status != "dismissed" {
		t.Fatalf("nodes = %+v", nodes)
	}
}
