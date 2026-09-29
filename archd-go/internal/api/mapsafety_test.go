package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

func post(t *testing.T, handler func(http.ResponseWriter, *http.Request), path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, _ := json.Marshal(body)
	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(encoded)))
	return recorder
}

func TestMapsSurviveTrashBackupExportAndImport(t *testing.T) {
	eventHub := hub.New()
	dataDir := t.TempDir()
	server := NewServer(dataDir, eventHub, runtime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertSystem(sqlDB, db.System{ID: "sys-1", WorkspaceID: "ws", Name: "Checkout", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	projectDir := filepath.Join(dataDir, "ws")

	// Daily backups: one per day, however often the project opens.
	now := time.Now()
	if taken, err := backupIfDue(sqlDB, projectDir, now); err != nil || !taken {
		t.Fatalf("first backup: taken=%v err=%v", taken, err)
	}
	if taken, _ := backupIfDue(sqlDB, projectDir, now.Add(time.Hour)); taken {
		t.Fatal("a second backup within a day")
	}
	backups := listBackups(projectDir)
	if len(backups) != 1 {
		t.Fatalf("backups = %#v", backups)
	}

	// Export.
	exportPath := filepath.Join(t.TempDir(), "shop.axiommap")
	recorder := post(t, server.handleWorkspaceExport, "/api/workspace-export", exportReq{
		WorkspaceID: "ws", Path: exportPath, Manifest: map[string]string{"name": "shop", "rootPath": "/old/shop"},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("export: %d %s", recorder.Code, recorder.Body.String())
	}
	manifest, _, err := readExportManifest(exportPath)
	if err != nil || manifest["name"] != "shop" || manifest["workspaceId"] != "ws" {
		t.Fatalf("manifest = %#v err=%v", manifest, err)
	}

	// Delete goes to the trash, not away.
	trashPath, err := server.trashWorkspace("ws")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(trashPath, "axiom.db")); err != nil {
		t.Fatalf("trashed map is gone: %v", err)
	}
	if _, err := os.Stat(projectDir); !os.IsNotExist(err) {
		t.Fatal("the project folder is still in place after trashing")
	}

	// Import brings the map back under its own id, without the manifest.
	recorder = post(t, server.handleWorkspaceImport, "/api/workspace-import", importReq{Path: exportPath})
	if recorder.Code != http.StatusOK {
		t.Fatalf("import: %d %s", recorder.Code, recorder.Body.String())
	}
	imported, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	systems, err := db.GetSystems(imported, "ws")
	if err != nil || len(systems) != 1 || systems[0].Name != "Checkout" {
		t.Fatalf("imported systems = %#v err=%v", systems, err)
	}
	var leftover int
	_ = imported.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = ?`, exportManifest).Scan(&leftover)
	if leftover != 0 {
		t.Fatal("the export manifest was left inside the live map")
	}

	// Importing over an existing map needs an explicit replace.
	recorder = post(t, server.handleWorkspaceImport, "/api/workspace-import", importReq{Path: exportPath})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("second import: %d, want 409", recorder.Code)
	}
	recorder = post(t, server.handleWorkspaceImport, "/api/workspace-import", importReq{Path: exportPath, Replace: true})
	if recorder.Code != http.StatusOK {
		t.Fatalf("replace import: %d %s", recorder.Code, recorder.Body.String())
	}
	var replaced struct {
		ReplacedTrashPath string `json:"replacedTrashPath"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &replaced); err != nil || replaced.ReplacedTrashPath == "" {
		t.Fatalf("replace import did not report where the old map went: %s", recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(replaced.ReplacedTrashPath, "axiom.db")); err != nil {
		t.Fatalf("replaced map is not in the trash: %v", err)
	}

	// Restoring a backup keeps a safety copy of what it replaces.
	if taken, err := backupIfDue(mustDB(t, server), projectDir, now); err != nil || !taken {
		t.Fatalf("backup after import: taken=%v err=%v", taken, err)
	}
	name := listBackups(projectDir)[0].Name
	recorder = post(t, server.handleWorkspaceRestoreBackup, "/api/workspace-restore-backup", restoreBackupReq{WorkspaceID: "ws", Name: name})
	if recorder.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", recorder.Code, recorder.Body.String())
	}
	if len(listBackups(projectDir)) < 2 {
		t.Fatal("restore did not keep a copy of the map it replaced")
	}
	recorder = post(t, server.handleWorkspaceRestoreBackup, "/api/workspace-restore-backup", restoreBackupReq{WorkspaceID: "ws", Name: "../../etc/passwd.db"})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("path traversal in backup name: %d", recorder.Code)
	}
	t.Cleanup(func() { server.closeDB("ws") })
}

func mustDB(t *testing.T, server *Server) *sql.DB {
	t.Helper()
	sqlDB, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	return sqlDB
}

func TestTrashFolderIsNeverAWorkspace(t *testing.T) {
	if validWorkspaceID(".trash") || validWorkspaceID(".") || validWorkspaceID("..") {
		t.Fatal("dot-prefixed ids must be rejected")
	}
}
