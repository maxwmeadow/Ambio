package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// A map written by any earlier Ambio opens with this one: the data survives
// and today's features work on it. The fixtures were written by the older
// versions' own code (testdata/schemagen).
func TestMapsFromEarlierSchemasUpgrade(t *testing.T) {
	for _, fixture := range []string{"schema-v0.sql", "schema-v1.sql", "schema-v2.sql"} {
		t.Run(fixture, func(t *testing.T) {
			dir := t.TempDir()
			script, err := os.ReadFile(filepath.Join("testdata", fixture))
			if err != nil {
				t.Fatal(err)
			}
			raw, err := sql.Open("sqlite3", filepath.Join(dir, "ambio.db"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := raw.Exec(string(script)); err != nil {
				t.Fatalf("replay %s: %v", fixture, err)
			}
			_ = raw.Close()

			sqlDB, err := Open(dir)
			if err != nil {
				t.Fatalf("open %s: %v", fixture, err)
			}
			t.Cleanup(func() { _ = sqlDB.Close() })
			var version int
			must(t, sqlDB.QueryRow(`PRAGMA user_version`).Scan(&version))
			if version != SchemaVersion {
				t.Fatalf("upgraded to v%d, want v%d", version, SchemaVersion)
			}

			// What the older Ambio wrote is still there.
			systems, err := GetSystems(sqlDB, "ws")
			must(t, err)
			files, err := GetFiles(sqlDB, "ws")
			must(t, err)
			deps, err := GetDependencies(sqlDB, "ws")
			must(t, err)
			elements, err := GetSheetElements(sqlDB, "sheet")
			must(t, err)
			message, err := GetCanvasMessage(sqlDB, "order")
			must(t, err)
			events, err := GetStructuralEvents(sqlDB, "ws", 0)
			must(t, err)
			if len(systems) != 2 || len(files) != 2 || len(deps) != 1 || len(elements) != 1 || message == nil || len(events) != 1 {
				t.Fatalf("data lost: %d systems, %d files, %d deps, %d elements, message %v, %d events",
					len(systems), len(files), len(deps), len(elements), message != nil, len(events))
			}

			// And today's features work on it.
			_, err = ApplyMeaningEdits(sqlDB, "ws", MeaningActor{Kind: "human"}, []MeaningEdit{
				{Op: MeaningAssign, FileIDs: []string{"cart"}, SystemID: "payments"},
			})
			must(t, err)
			_, err = CodeFit(sqlDB, "ws", []string{"cart"})
			must(t, err)
			_, err = ProposeSheetRemoval(sqlDB, "ws", "sheet", "stripe", "user")
			must(t, err)
			must(t, SaveWorkOrderCodeChecks(sqlDB, "order", []CodeFitFinding{{Kind: CodeFitFolder, FileID: "cart", SystemID: "payments"}}))
			if _, err := CompareSheetStructure(sqlDB, "ws", "sheet"); err != nil {
				t.Fatalf("compare on an upgraded map: %v", err)
			}

			// Opening again is a no-op.
			_ = sqlDB.Close()
			reopened, err := Open(dir)
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			_ = reopened.Close()
		})
	}
}
