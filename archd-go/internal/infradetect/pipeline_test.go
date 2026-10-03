package infradetect_test

import (
	"os"
	"path/filepath"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	"ambio.local/archd/internal/indexer"
	"ambio.local/archd/internal/infradetect"
	"ambio.local/archd/internal/registry"
)

// Detection end to end on a small project: index it, load the inputs,
// analyze, and apply - the path archd runs after every settled change.
func TestDetectionFindsAProjectsInfrastructureEndToEnd(t *testing.T) {
	rootPath := t.TempDir()
	files := map[string]string{
		"package.json":       `{"name":"shop","dependencies":{"ioredis":"^5.0.0","pg":"^8.0.0"}}`,
		"src/cache.ts":       "import Redis from 'ioredis'\nconst redis = new Redis(process.env.REDIS_URL)\nexport function saveCart(id: string) {\n  return redis.set(`cart:${id}`, '1')\n}\n",
		"src/orders.ts":      "import { Pool } from 'pg'\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL })\nexport function listOrders() {\n  return pool.query('SELECT * FROM orders')\n}\n",
		"docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n",
		".env.example":       "DATABASE_URL=\nREDIS_URL=\n",
	}
	for rel, body := range files {
		path := filepath.Join(rootPath, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: rootPath, IsPrimary: true}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := indexer.IndexRoot(sqlDB, hub.New(), root, nil); err != nil {
		t.Fatal(err)
	}

	in, err := infradetect.Load(sqlDB, root, registry.Load([]string{rootPath}))
	if err != nil {
		t.Fatal(err)
	}
	result := infradetect.Analyze(in)
	var cacheFile string
	if err := sqlDB.QueryRow(`SELECT id FROM files WHERE rel_path = 'src/cache.ts'`).Scan(&cacheFile); err != nil {
		t.Fatal(err)
	}
	byService := map[string]infradetect.Proposal{}
	for _, p := range result.Proposals {
		byService[p.Service] = p
	}
	if p, ok := byService["postgresql/postgres"]; !ok || p.Category != "database" {
		t.Fatalf("PostgreSQL not proposed: %+v", result.Proposals)
	}
	cache, ok := byService["redis/redis"]
	if !ok || cache.Category != "cache" {
		t.Fatalf("Redis not proposed: %+v", result.Proposals)
	}
	wroteCart := false
	for _, e := range cache.Edges {
		if e.FileID == cacheFile && e.Kind == "WRITES" && e.Item == "cart:{}" {
			wroteCart = true
		}
	}
	if !wroteCart {
		t.Fatalf("cache.ts writing cart:{} not found: %+v", cache.Edges)
	}
	required := map[string]bool{}
	for _, r := range result.Requirements {
		required[r.Name] = r.Present
	}
	if present, ok := required["DATABASE_URL"]; !ok || present {
		t.Fatalf("DATABASE_URL should be required and not set: %+v", result.Requirements)
	}

	changes, err := infradetect.Apply(sqlDB, "ws", "root", result)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes.Upserted) != 2 || len(changes.Linked) != 3 {
		t.Fatalf("applied %d nodes and %d links, want 2 and 3", len(changes.Upserted), len(changes.Linked))
	}
	nodes, _ := db.GetInfraNodes(sqlDB, "ws")
	for _, node := range nodes {
		if node.Status != "proposed" {
			t.Fatalf("detection decided for the person: %+v", node)
		}
	}
}
