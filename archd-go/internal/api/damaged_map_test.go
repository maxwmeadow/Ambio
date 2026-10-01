package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

// A damaged map is reported with what it can be restored from, is never
// backed up over the good backups, and comes back from its newest backup.
func TestADamagedMapIsReportedAndRestored(t *testing.T) {
	for name, damage := range map[string]func(path string) error{
		"header": func(path string) error {
			file, err := os.OpenFile(path, os.O_WRONLY, 0)
			if err != nil {
				return err
			}
			defer file.Close()
			_, err = file.WriteAt([]byte(strings.Repeat("x", 100)), 0)
			return err
		},
		"pages": func(path string) error {
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for i := 4096 * 2; i < len(raw)-4096; i++ {
				raw[i] = byte(i * 7)
			}
			return os.WriteFile(path, raw, 0o600)
		},
	} {
		t.Run(name, func(t *testing.T) {
			dataDir := t.TempDir()
			server := NewServer(dataDir, hub.New(), runtime.NewManager(hub.New()))
			t.Cleanup(func() { server.closeDB("ws") })
			sqlDB, err := server.openDB("ws")
			if err != nil {
				t.Fatal(err)
			}
			for _, step := range []error{
				db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}),
				db.UpsertSystem(sqlDB, db.System{ID: "orders", WorkspaceID: "ws", Name: "Orders", Source: "user"}),
			} {
				if step != nil {
					t.Fatal(step)
				}
			}
			for i := 0; i < 200; i++ { // enough pages to damage
				_ = db.UpsertSystem(sqlDB, db.System{ID: "s" + string(rune('a'+i%26)) + string(rune('a'+i/26)), WorkspaceID: "ws", Name: strings.Repeat("n", 200), Source: "user"})
			}
			projectDir := filepath.Join(dataDir, "ws")
			if _, err := backupIfDue(sqlDB, projectDir, time.Now()); err != nil {
				t.Fatal(err)
			}
			server.closeDB("ws")
			if err := damage(filepath.Join(projectDir, "axiom.db")); err != nil {
				t.Fatal(err)
			}

			opened := send(t, server, http.MethodPost, "/api/workspace", map[string]any{"workspaceId": "ws", "name": "shop", "rootPath": t.TempDir()})
			if opened.Code != http.StatusConflict {
				t.Fatalf("a damaged map opened: %d %s", opened.Code, opened.Body.String())
			}
			var body struct {
				Damaged struct {
					Backups []backupInfo `json:"backups"`
				} `json:"damaged"`
			}
			if err := json.Unmarshal(opened.Body.Bytes(), &body); err != nil || len(body.Damaged.Backups) != 1 {
				t.Fatalf("no backup offered: %s", opened.Body.String())
			}
			if backups := listBackups(projectDir); len(backups) != 1 {
				t.Fatalf("the damaged map was backed up: %+v", backups)
			}

			restored := send(t, server, http.MethodPost, "/api/workspace-restore-backup", map[string]any{
				"workspaceId": "ws", "name": body.Damaged.Backups[0].Name,
			})
			if restored.Code != http.StatusOK {
				t.Fatalf("restore: %d %s", restored.Code, restored.Body.String())
			}
			kept, _ := filepath.Glob(filepath.Join(projectDir, "damaged-*.db.bak"))
			if len(kept) != 1 {
				t.Fatalf("the damaged map was not kept aside: %v", kept)
			}
			healthy, err := server.dbFor("ws")
			if err != nil {
				t.Fatal(err)
			}
			if problem := mapIntegrityProblem(healthy); problem != "" {
				t.Fatalf("restored map is not healthy: %s", problem)
			}
			if system, _ := db.GetSystem(healthy, "orders"); system == nil {
				t.Fatal("the restored map lost its systems")
			}
		})
	}
}
