package infradetect

import (
	"reflect"
	"sort"
	"testing"
)

// Helios: a Python backend whose notes live in an embedded Chroma store.
func TestAVectorDatabaseIsNamed(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"notes": "backend/note_service.py", "faces": "backend/face_index.py"}, nil,
		map[string][]string{"notes": {"chromadb", "chromadb.config"}, "faces": {"pgvector.psycopg"}},
		map[string]string{"backend/requirements.txt": "fastapi==0.115.0\nchromadb==0.5.23\n"},
	))
	chroma := find(result, "chroma/chroma")
	if chroma == nil || chroma.Subtype != "vector" || chroma.DeclaredOnly || len(chroma.Edges) != 1 {
		t.Fatalf("note_service.py uses Chroma: %+v", chroma)
	}
	if find(result, "postgresql/postgres") == nil {
		t.Errorf("pgvector is Postgres with an extension, not a store of its own: %+v", result.Proposals)
	}
}

func TestAGenericRoleStandsInForAnUnknownProvider(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"search": "ml/similar.py"}, nil,
		map[string][]string{"search": {"faiss"}},
		map[string]string{"ml/requirements.txt": "faiss-cpu==1.8.0\n"},
	))
	vector := find(result, "generic/vector-database")
	if vector == nil || vector.DeclaredOnly || len(vector.Edges) != 1 {
		t.Fatalf("faiss says the role, not the provider: %+v", result.Proposals)
	}
}

func TestAGenericFoldsIntoTheNamedServiceForItsRole(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"db": "src/db.ts", "report": "src/report.ts"}, nil,
		map[string][]string{"db": {"pg"}, "report": {"knex"}},
		map[string]string{"package.json": `{"dependencies":{"pg":"8","knex":"3"}}`},
	))
	if find(result, "generic/database") != nil {
		t.Errorf("knex beside pg is the same Postgres: %+v", result.Proposals)
	}
	postgres := find(result, "postgresql/postgres")
	if postgres == nil || len(postgres.Edges) != 2 {
		t.Fatalf("both files reach Postgres: %+v", postgres)
	}
}

func TestAGenericBesideSeveralNamedServicesIsLeftForTheAgent(t *testing.T) {
	result := Analyze(inputs(
		map[string]string{"chain": "agent/chain.py", "a": "agent/openai_client.py", "b": "agent/claude_client.py"}, nil,
		map[string][]string{"chain": {"langchain"}, "a": {"openai"}, "b": {"anthropic"}},
		nil,
	))
	if find(result, "generic/llm") != nil {
		t.Errorf("which provider langchain calls is the agent's call: %+v", result.Proposals)
	}
	var candidates []string
	for _, u := range result.Unresolved {
		if u.Package == "langchain" {
			candidates = append(candidates, u.Candidates...)
		}
	}
	sort.Strings(candidates)
	if !reflect.DeepEqual(candidates, []string{"anthropic/api", "openai/api"}) {
		t.Errorf("langchain is left between the two providers: %+v", result.Unresolved)
	}
}

func TestJVMPHPSwiftAndElixirImportsAndManifests(t *testing.T) {
	in := inputs(nil, nil, nil, map[string]string{
		"composer.json": `{"require":{"php":"^8.2","sentry/sentry":"^4.0"}}`,
		"build.sbt":     `libraryDependencies += "com.twilio.sdk" % "twilio" % "10.0.0"` + "\n" + `libraryDependencies += "io.qdrant" %% "client" % "1.9.0"`,
		"Package.swift": `.target(name: "App", dependencies: [.product(name: "Supabase", package: "supabase-swift")])`,
		"mix.exs":       "defp deps do\n  [{:phoenix, \"~> 1.7\"}, {:redix, \"~> 1.5\"}]\nend\n",
	})
	for id, spec := range map[string][2]string{
		"kt": {"app/Billing.kt", "kotlin"}, "scala": {"src/Cache.scala", "scala"}, "groovy": {"src/Jobs.groovy", "groovy"},
		"php": {"src/Upload.php", "php"}, "swift": {"App/Auth.swift", "swift"}, "ex": {"lib/app/notes.ex", "elixir"},
	} {
		in.Files = append(in.Files, File{ID: id, RelPath: spec[0], Language: spec[1]})
	}
	in.Packages = append(in.Packages,
		PackageUse{FileID: "kt", Package: "com.stripe.Stripe", Line: 2},
		PackageUse{FileID: "scala", Package: "redis.clients.jedis", Line: 1},
		PackageUse{FileID: "groovy", Package: "org.apache.kafka.clients.producer.KafkaProducer", Line: 1},
		PackageUse{FileID: "php", Package: `Aws\S3\S3Client`, Line: 3},
		PackageUse{FileID: "swift", Package: "FirebaseAuth", Line: 1},
		PackageUse{FileID: "ex", Package: "Postgrex", Line: 2},
	)
	result := Analyze(in)
	for service, file := range map[string]string{
		"stripe/api": "kt", "redis/redis": "scala", "apache/kafka": "groovy",
		"aws/s3": "php", "firebase/auth": "swift", "postgresql/postgres": "ex",
	} {
		p := find(result, service)
		if p == nil || len(p.Edges) != 1 || p.Edges[0].FileID != file {
			t.Errorf("%s from the %s import: %+v", service, file, p)
		}
	}
	for _, service := range []string{"sentry/observability", "twilio/api", "qdrant/qdrant", "supabase/supabase"} {
		if p := find(result, service); p == nil || !p.DeclaredOnly {
			t.Errorf("%s declared by composer.json, build.sbt, Package.swift or mix.exs: %+v", service, p)
		}
	}
	if p := find(result, "redis/redis"); p == nil || p.DeclaredOnly {
		t.Errorf("mix.exs's redix adds to the Redis a Scala file already uses: %+v", p)
	}
}
