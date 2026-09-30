package infradetect

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/indexer"
	"axiom.local/archd/internal/registry"
)

// harborResult indexes the harbor lab project (docs/INFRA.md L0) and
// runs detection on it. The lab lives outside the repo; the test skips when it
// is absent.
func harborResult(t *testing.T) (Result, map[string]string) {
	t.Helper()
	home, _ := os.UserHomeDir()
	rootPath := filepath.Join(home, "dev", "axiom-lab", "harbor")
	if _, err := os.Stat(filepath.Join(rootPath, "package.json")); err != nil {
		t.Skip("harbor lab project not present")
	}
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "harbor"}); err != nil {
		t.Fatal(err)
	}
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: rootPath, IsPrimary: true}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := indexer.IndexRoot(sqlDB, hub.New(), root, []string{filepath.Join(rootPath, "node_modules"), filepath.Join(rootPath, ".git")}); err != nil {
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
	return Analyze(in), paths
}

func edgesOf(p Proposal, paths map[string]string, kind string) []string {
	var out []string
	for _, e := range p.Edges {
		if e.Kind == kind {
			out = append(out, paths[e.FileID])
		}
	}
	sort.Strings(out)
	return out
}

func find(result Result, service string) *Proposal {
	for i := range result.Proposals {
		if result.Proposals[i].Service == service {
			return &result.Proposals[i]
		}
	}
	return nil
}

func TestHarborDetection(t *testing.T) {
	result, paths := harborResult(t)
	for _, p := range result.Proposals {
		t.Logf("%-24s implements=%v uses=%v impls=%d contents=%d declaredOnly=%v",
			p.Service, edgesOf(p, paths, "IMPLEMENTS"), edgesOf(p, paths, "USES"), len(p.Implementations), len(p.Contents), p.DeclaredOnly)
		for _, impl := range p.Implementations {
			t.Logf("    %s %s %s", impl.Kind, impl.Ref, impl.Evidence)
		}
	}
	for _, r := range result.Requirements {
		t.Logf("env %-24s → %s", r.Name, r.Service)
	}
	for _, u := range result.Unresolved {
		t.Logf("unresolved %s %v", u.Package, u.Candidates)
	}

	for _, service := range []string{
		"postgresql/postgres", "redis/redis", "bullmq/bullmq", "stripe/api", "openai/api", "aws/s3",
		"resend/email", "sentry/observability", "posthog/observability", "node-cron/cron", "vercel/platform", "vercel/cron",
	} {
		if find(result, service) == nil {
			t.Errorf("harbor uses %s", service)
		}
	}

	pg := find(result, "postgresql/postgres")
	if pg == nil {
		t.FailNow()
	}
	implements := strings.Join(edgesOf(*pg, paths, "IMPLEMENTS"), " ")
	for _, want := range []string{"src/infra/db/postgres.ts", "src/infra/db/index.ts", "src/infra/db/sqlite.ts"} {
		if !strings.Contains(implements, want) {
			t.Errorf("Postgres is implemented by %s (the adapter, the facade and the SQLite stand-in); got %s", want, implements)
		}
	}
	uses := strings.Join(edgesOf(*pg, paths, "USES"), " ")
	for _, want := range []string{"src/repos/bookings.ts", "src/repos/marinas.ts", "src/infra/db/migrate.ts"} {
		if !strings.Contains(uses, want) {
			t.Errorf("%s uses Postgres; got %s", want, uses)
		}
	}
	kinds := map[string]string{}
	for _, impl := range pg.Implementations {
		kinds[impl.Ref] = impl.Kind
	}
	if kinds["src/infra/db/sqlite.ts"] != "in-process" || kinds["compose:postgres"] != "local-service" || kinds["src/infra/db/postgres.ts"] != "vendor" {
		t.Errorf("Postgres locally: vendor adapter, SQLite stand-in, compose service; got %v", kinds)
	}

	stripe := find(result, "stripe/api")
	if stripe != nil {
		kinds := map[string]string{}
		for _, impl := range stripe.Implementations {
			kinds[impl.Ref] = impl.Kind
		}
		if kinds["src/infra/payments/fake.ts"] != "in-process" || kinds["compose:stripe-mock"] != "emulator" {
			t.Errorf("Stripe locally: the fake ledger and stripe-mock; got %v", kinds)
		}
	}
	if email := find(result, "resend/email"); email != nil {
		found := false
		for _, impl := range email.Implementations {
			found = found || impl.Ref == "compose:mailpit"
		}
		if !found {
			t.Errorf("Mailpit stands in for email: %+v", email.Implementations)
		}
	}
	if cron := find(result, "vercel/cron"); cron == nil || len(cron.Contents) != 3 {
		t.Errorf("vercel.json declares three crons: %+v", cron)
	}
	if cron := find(result, "node-cron/cron"); cron == nil || len(cron.Contents) != 3 {
		t.Errorf("the scheduler declares three schedules: %+v", cron)
	}
	if cron := find(result, "node-cron/cron"); cron != nil {
		jobs := strings.Join(edgesOf(*cron, paths, "SCHEDULED_BY"), " ")
		for _, want := range []string{"src/jobs/expireHolds.ts", "src/jobs/sendReminders.ts", "src/jobs/summarizeReviews.ts"} {
			if !strings.Contains(jobs, want) {
				t.Errorf("%s is scheduled by node-cron; got %s", want, jobs)
			}
		}
		if strings.Contains(jobs, "telemetry") {
			t.Errorf("the error reporter the scheduler wraps jobs with is not a job; got %s", jobs)
		}
	}
	if cron := find(result, "vercel/cron"); cron != nil {
		if jobs := edgesOf(*cron, paths, "SCHEDULED_BY"); len(jobs) == 0 || jobs[0] != "src/http/routes/cron.ts" {
			t.Errorf("Vercel Cron calls the routes in cron.ts; got %v", jobs)
		}
	}
	if vercel := find(result, "vercel/platform"); vercel != nil {
		if runs := edgesOf(*vercel, paths, "RUNS_ON"); len(runs) != 1 || runs[0] != "src/http/server.ts" {
			t.Errorf("server.ts runs on Vercel; got %v", runs)
		}
	}
	// Contracts: the tables Postgres holds and who writes them, the topics the
	// queue carries and the one that is published with nobody listening.
	tables := map[string]bool{}
	for _, c := range pg.Contents {
		if c.Kind == "table" {
			tables[c.Name] = true
		}
	}
	for _, want := range []string{"bookings", "marinas", "slips"} {
		if !tables[want] {
			t.Errorf("migrations create %s; got %v", want, tables)
		}
	}
	writers := map[string]bool{}
	for _, e := range pg.Edges {
		if e.Kind == "WRITES" {
			writers[paths[e.FileID]+" "+e.Item] = true
		}
	}
	if !writers["src/repos/bookings.ts bookings"] {
		t.Errorf("bookings.ts writes bookings; got %v", writers)
	}
	if queue := find(result, "bullmq/bullmq"); queue != nil {
		topics := map[string]string{}
		for _, c := range queue.Contents {
			warning, _ := c.Detail["warning"].(string)
			topics[c.Name] = warning
			t.Logf("topic %s %v", c.Name, c.Detail)
		}
		if warning, ok := topics["booking.reminder"]; !ok || !strings.Contains(warning, `only "booking.reminders" is consumed`) {
			t.Errorf("booking.reminder is published with no consumer, next to a near-identical consumed topic; got %v", topics)
		}
		if warning, ok := topics["booking.reminders"]; !ok || !strings.Contains(warning, `only "booking.reminder" is published`) {
			t.Errorf("booking.reminders is consumed but never published; got %v", topics)
		}
	}
	owners := map[string]string{}
	for _, r := range result.Requirements {
		owners[r.Name] = r.Service
	}
	for name, service := range map[string]string{
		"DATABASE_URL": "postgresql/postgres", "REDIS_URL": "redis/redis", "STRIPE_SECRET_KEY": "stripe/api",
		"OPENAI_API_KEY": "openai/api", "S3_BUCKET": "aws/s3", "RESEND_API_KEY": "resend/email", "SESSION_SECRET": "",
		"AWS_REGION": "aws/s3", "AWS_SECRET_ACCESS_KEY": "aws/s3", "MAIL_FROM": "resend/email",
	} {
		if owners[name] != service {
			t.Errorf("%s belongs to %q, got %q", name, service, owners[name])
		}
	}
}
