package infradetect

import (
	"strings"
	"testing"

	"axiom.local/archd/internal/registry"
)

func inputs(files map[string]string, imports [][2]string, packages map[string][]string, config map[string]string) Inputs {
	in := Inputs{Config: map[string][]byte{}, Registry: registry.Load(nil)}
	for id, rel := range files {
		lang := "typescript"
		if strings.HasSuffix(rel, ".py") {
			lang = "python"
		}
		in.Files = append(in.Files, File{ID: id, RelPath: rel, Language: lang})
	}
	for _, pair := range imports {
		in.Imports = append(in.Imports, Import{From: pair[0], To: pair[1]})
	}
	for id, pkgs := range packages {
		for _, pkg := range pkgs {
			in.Packages = append(in.Packages, PackageUse{FileID: id, Package: pkg, Line: 1})
		}
	}
	for rel, body := range config {
		in.Config[rel] = []byte(body)
	}
	return in
}

func TestAFileUsingAnSDKDirectlyUsesTheRole(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"checkout": "src/routes/checkout.ts", "refund": "src/routes/refund.ts"},
		nil,
		map[string][]string{"checkout": {"stripe"}, "refund": {"stripe"}},
		nil,
	))
	stripe := find(result, "stripe/api")
	if stripe == nil || len(stripe.Edges) != 2 {
		t.Fatalf("both routes use Stripe: %+v", stripe)
	}
	for _, e := range stripe.Edges {
		if e.Kind != "USES" {
			t.Errorf("no file imports them, so neither is an adapter: %+v", e)
		}
	}
	if len(stripe.Implementations) != 0 {
		t.Errorf("no adapter, no stand-in: %+v", stripe.Implementations)
	}
}

func TestAnAmbiguousPackageIsLeftForTheAgent(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"jobs": "worker/jobs.py"}, nil,
		map[string][]string{"jobs": {"boto3"}}, nil,
	))
	if len(result.Proposals) != 0 {
		t.Errorf("boto3 alone could be any AWS service; propose nothing: %+v", result.Proposals)
	}
	if len(result.Unresolved) != 1 || len(result.Unresolved[0].Candidates) < 2 {
		t.Errorf("but say what was seen: %+v", result.Unresolved)
	}
}

func TestADeclaredButUnusedPackageIsMarked(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"app": "src/app.ts"}, nil, nil,
		map[string]string{"package.json": `{"dependencies":{"openai":"^4","left-pad":"1"}}`},
	))
	openai := find(result, "openai/api")
	if openai == nil || !openai.DeclaredOnly {
		t.Fatalf("openai is declared but no file loads it: %+v", openai)
	}
}

func TestLocalEnvValuesAreNeverRead(t *testing.T) {
	in := inputs(map[string]string{"db": "src/db.ts"}, nil, map[string][]string{"db": {"pg"}},
		map[string]string{
			".env.example": "DATABASE_URL=postgres://localhost/app\n",
			".env":         "DATABASE_URL=postgres://admin:hunter2@prod/app\n",
		})
	result := Analyze(in)
	for _, r := range result.Requirements {
		if strings.Contains(r.Evidence, "hunter2") || strings.Contains(r.Name, "hunter2") {
			t.Fatalf("a value leaked into a requirement: %+v", r)
		}
		if r.Name == "DATABASE_URL" && (!r.Present || r.Service != "postgresql/postgres") {
			t.Errorf("DATABASE_URL is defined locally and belongs to Postgres: %+v", r)
		}
	}
}

func TestSQLItemEdges(t *testing.T) {
	d := &detection{in: Inputs{
		Config: map[string][]byte{"db/001.sql": []byte("CREATE TABLE bookings (\n  id text primary key,\n  status text\n);\nCREATE TABLE slips (\n  id text\n);\n")},
		ReadSource: func(string) []byte {
			return []byte("await db.query('DELETE FROM bookings WHERE id = $1')\nawait db.query('select * from slips join bookings on 1=1')\n")
		},
	}, files: map[string]File{"f": {ID: "f", RelPath: "src/repo.ts"}}}
	p := &Proposal{Service: "postgresql/postgres", Category: "database", Subtype: "sql", Edges: []Edge{{FileID: "f", Kind: "USES"}}}
	d.proposals = map[string]*Proposal{p.Service: p}
	d.extractTables()
	got := map[string]bool{}
	for _, e := range p.Edges {
		if e.Item != "" {
			got[e.Kind+" "+e.Item] = true
		}
	}
	want := map[string]bool{"WRITES bookings": true, "READS slips": true, "READS bookings": true}
	for k := range want {
		if !got[k] {
			t.Errorf("missing %s in %v", k, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("unexpected edges %v", got)
	}
	if len(p.Contents) != 2 {
		t.Errorf("two tables: %+v", p.Contents)
	}
}

func TestOtherLanguagesAndFrameworkConfig(t *testing.T) {
	in := inputs(nil, nil, nil, map[string]string{
		"Gemfile":             "source 'https://rubygems.org'\ngem 'rails'\ngem 'sidekiq'\n",
		"config/database.yml": "default: &default\n  adapter: postgresql\n",
		"api/Api.csproj":      `<Project><ItemGroup><PackageReference Include="Stripe.net" Version="45.0.0" /></ItemGroup></Project>`,
	})
	for id, spec := range map[string][2]string{
		"java": {"src/Billing.java", "java"}, "cs": {"Cache.cs", "csharp"}, "rs": {"src/cache.rs", "rust"},
	} {
		in.Files = append(in.Files, File{ID: id, RelPath: spec[0], Language: spec[1]})
	}
	in.Packages = append(in.Packages,
		PackageUse{FileID: "java", Package: "com.stripe.Stripe", Line: 2},
		PackageUse{FileID: "cs", Package: "StackExchange.Redis", Line: 2},
		PackageUse{FileID: "rs", Package: "redis", Line: 2},
	)
	result := Analyze(in)
	for _, service := range []string{"stripe/api", "redis/redis", "postgresql/postgres", "sidekiq/sidekiq"} {
		if find(result, service) == nil {
			t.Errorf("expected %s from Java, C#, Rust imports, a Gemfile and database.yml", service)
		}
	}
	if stripe := find(result, "stripe/api"); stripe != nil && len(stripe.Edges) == 0 {
		t.Errorf("the Java file using Stripe is connected: %+v", stripe)
	}
}
