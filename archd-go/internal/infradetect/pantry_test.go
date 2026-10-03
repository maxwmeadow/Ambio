package infradetect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
	"ambio.local/archd/internal/indexer"
	"ambio.local/archd/internal/registry"
)

// TestPantryDetection runs detection on the pantry lab (~/dev/ambio-lab):
// a TypeScript API, a Python worker and a Go service, written without looking
// at the detector, scored against its answer key. It skips when the lab is
// absent.
func TestPantryDetection(t *testing.T) {
	home, _ := os.UserHomeDir()
	rootPath := filepath.Join(home, "dev", "ambio-lab", "pantry")
	if _, err := os.Stat(filepath.Join(rootPath, "README.md")); err != nil {
		t.Skip("pantry lab project not present")
	}
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	_ = db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "pantry"})
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: rootPath, IsPrimary: true}
	_ = db.UpsertRoot(sqlDB, root)
	if err := indexer.IndexRoot(sqlDB, hub.New(), root, []string{filepath.Join(rootPath, ".git")}); err != nil {
		t.Fatal(err)
	}
	in, err := Load(sqlDB, root, registry.Load(nil))
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{}
	for _, f := range in.Files {
		paths[f.ID] = f.RelPath
	}
	result := Analyze(in)
	byKey := map[string]*Proposal{}
	for i := range result.Proposals {
		byKey[proposalKey(&result.Proposals[i])] = &result.Proposals[i]
	}

	expected := []string{
		"postgresql/postgres", "upstash/redis", "redis/redis", "rabbitmq/rabbitmq", "apache/kafka", "celery/celery",
		"mongodb/mongodb", "aws/s3", "stripe/api", "anthropic/api", "resend/email", "twilio/sendgrid", "clerk/auth",
		"launchdarkly/flags", "pusher/realtime", "sentry/observability", "datadog/observability", "fly/platform",
		"github/actions-schedule", "docker/docker#api", "docker/docker#worker", "docker/docker#routing",
	}
	found := 0
	for _, key := range expected {
		if byKey[key] != nil {
			found++
		} else {
			t.Errorf("pantry uses %s", key)
		}
	}
	t.Logf("services: %d of %d expected, %d proposed", found, len(expected), len(result.Proposals))

	has := func(key, kind, file, item string) bool {
		p := byKey[key]
		if p == nil {
			return false
		}
		for _, e := range p.Edges {
			if e.Kind == kind && paths[e.FileID] == file && e.Item == item {
				return true
			}
		}
		return false
	}
	for _, want := range []struct{ key, kind, file, item string }{
		{"postgresql/postgres", "USES", "worker/pantry_worker/tasks/receipts.py", ""},
		{"postgresql/postgres", "WRITES", "api/src/services/checkout.ts", "order"},
		{"postgresql/postgres", "WRITES", "worker/pantry_worker/tasks/inventory.py", "product"},
		{"rabbitmq/rabbitmq", "USES", "worker/pantry_worker/celery_app.py", ""},
		{"aws/s3", "IMPLEMENTS", "worker/pantry_worker/storage.py", ""},
		{"mongodb/mongodb", "USES", "routing/internal/planner/planner.go", ""},
		{"apache/kafka", "PUBLISHES", "api/src/services/checkout.ts", "orders.placed"},
		{"apache/kafka", "CONSUMES", "routing/internal/events/consumer.go", "order.placed"},
		{"github/actions-schedule", "SCHEDULED_BY", "worker/pantry_worker/tasks/reports.py", ""},
	} {
		if !has(want.key, want.kind, want.file, want.item) {
			t.Errorf("%s %s %s %s", want.file, want.kind, want.key, want.item)
		}
	}

	// The seeded bugs detection can see without running anything.
	warning := func(key, kind, name string) string {
		if p := byKey[key]; p != nil {
			for _, c := range p.Contents {
				if c.Kind == kind && c.Name == name {
					w, _ := c.Detail["warning"].(string)
					return w
				}
			}
		}
		return ""
	}
	if w := warning("apache/kafka", "topic", "orders.placed"); !strings.Contains(w, `"order.placed"`) {
		t.Errorf("bug c: the API publishes orders.placed, routing reads order.placed; got %q", w)
	}
	if w := warning("rabbitmq/rabbitmq", "topic", "receipts"); !strings.Contains(w, `"receipt"`) {
		t.Errorf("bug b: the API sends to receipts, the worker consumes receipt; got %q", w)
	}
	if w := warning("upstash/redis", "key_pattern", "catalog"); !strings.Contains(w, `"catalog:all"`) {
		t.Errorf("bug a: restock deletes catalog, reads use catalog:all; got %q", w)
	}

	owners := map[string]string{}
	for _, r := range result.Requirements {
		owners[r.Name] = r.Service
	}
	for name, service := range map[string]string{
		"DATABASE_URL": "postgresql/postgres", "RABBITMQ_URL": "rabbitmq/rabbitmq", "MONGODB_URI": "mongodb/mongodb",
		"UPSTASH_REDIS_REST_URL": "upstash/redis", "SENDGRID_API_KEY": "twilio/sendgrid",
	} {
		if owners[name] != service {
			t.Errorf("%s belongs to %s, got %q", name, service, owners[name])
		}
	}
	if fly := byKey["fly/platform"]; fly != nil {
		via := ""
		for _, c := range fly.Contents {
			if c.Kind == "hosts" {
				via, _ = c.Detail["via"].(string)
			}
		}
		if via != "docker/docker#api" {
			t.Errorf("Fly runs the api image; got %q", via)
		}
	}
}
