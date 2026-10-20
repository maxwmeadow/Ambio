package db

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

// Exercise the real SQLite snapshot query and JSON encoding independently of
// renderer mocks. Fixtures are local synthetic metadata, not source indexing.
func BenchmarkCanvasSnapshotScale(b *testing.B) {
	for _, count := range []int{1000, 10000, 100000} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			database, err := Open(b.TempDir())
			if err != nil {
				b.Fatal(err)
			}
			b.Cleanup(func() { _ = database.Close() })
			if err := UpsertWorkspace(database, Workspace{ID: "scale", Name: "Scale"}); err != nil {
				b.Fatal(err)
			}
			if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "scale", Path: b.TempDir()}); err != nil {
				b.Fatal(err)
			}
			tx, err := database.Begin()
			if err != nil {
				b.Fatal(err)
			}
			defer tx.Rollback()
			statement, err := tx.Prepare(`INSERT INTO files (id,root_id,path,rel_path,language,line_count,indexed_at) VALUES (?,?,?,?,?,?,?)`)
			if err != nil {
				b.Fatal(err)
			}
			for i := 0; i < count; i++ {
				name := fmt.Sprintf("module-%d.ts", i)
				if _, err := statement.Exec(fmt.Sprint(i), "root", filepath.Join("fixture", name), name, "typescript", 100, 1); err != nil {
					b.Fatal(err)
				}
			}
			if err := statement.Close(); err != nil {
				b.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				b.Fatal(err)
			}
			b.Run("query", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					snapshot, err := GetCanvasSnapshot(database, "scale")
					if err != nil {
						b.Fatal(err)
					}
					if len(snapshot.Files) != count {
						b.Fatalf("snapshot lost files: %d", len(snapshot.Files))
					}
				}
			})
			snapshot, err := GetCanvasSnapshot(database, "scale")
			if err != nil {
				b.Fatal(err)
			}
			b.Run("json", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					body, err := json.Marshal(snapshot)
					if err != nil {
						b.Fatal(err)
					}
					b.ReportMetric(float64(len(body)), "payload-B")
				}
			})
		})
	}
}
