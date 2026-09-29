package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
)

// Protecting maps. A map is weeks of curation - systems, placement, sheets,
// history - and it lives only in the data directory. So deleting one moves it
// to a trash the app can restore from, every open takes a daily backup, and a
// map can be exported to a file and imported on another machine.

const (
	trashDirName   = ".trash"
	backupDirName  = "backups"
	backupsKept    = 7
	backupInterval = 24 * time.Hour
	exportManifest = "axiom_export_manifest"
)

// trashWorkspace closes a workspace and moves its folder to data/.trash, where
// the app keeps it for 30 days. Returns the trash folder.
func (s *Server) trashWorkspace(workspaceID string) (string, error) {
	projectDir, err := s.workspaceDataPath(workspaceID)
	if err != nil {
		return "", err
	}
	s.markWorkspaceDeleted(workspaceID)
	s.closeDB(workspaceID)
	if _, err := os.Stat(projectDir); os.IsNotExist(err) {
		return "", nil
	}
	trashRoot := filepath.Join(s.dataDir, trashDirName)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		return "", err
	}
	target := filepath.Join(trashRoot, fmt.Sprintf("%s-%d", workspaceID, time.Now().UnixMilli()))
	if err := os.Rename(projectDir, target); err != nil {
		return "", fmt.Errorf("move workspace to trash: %w", err)
	}
	return target, nil
}

// ─── Backups ────────────────────────────────────────────────────────────────

type backupInfo struct {
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	Bytes     int64  `json:"bytes"`
}

func listBackups(projectDir string) []backupInfo {
	entries, err := os.ReadDir(filepath.Join(projectDir, backupDirName))
	if err != nil {
		return []backupInfo{}
	}
	backups := []backupInfo{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".db") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		backups = append(backups, backupInfo{Name: entry.Name(), CreatedAt: info.ModTime().UnixMilli(), Bytes: info.Size()})
	}
	sort.Slice(backups, func(i, j int) bool { return backups[i].CreatedAt > backups[j].CreatedAt })
	return backups
}

// snapshotDatabase writes a consistent copy of a live database. VACUUM INTO
// works under WAL and concurrent readers, and produces a compact file.
func snapshotDatabase(sqlDB *sql.DB, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	_ = os.Remove(target)
	_, err := sqlDB.Exec(`VACUUM INTO ?`, target)
	return err
}

// backupIfDue takes today's backup of a workspace and trims old ones. Called
// when a project opens, so a project in use is never more than a day behind.
func backupIfDue(sqlDB *sql.DB, projectDir string, now time.Time) (bool, error) {
	backups := listBackups(projectDir)
	if len(backups) > 0 && now.Sub(time.UnixMilli(backups[0].CreatedAt)) < backupInterval {
		return false, nil
	}
	name := fmt.Sprintf("axiom-%s.db", now.Format("20060102-150405"))
	if err := snapshotDatabase(sqlDB, filepath.Join(projectDir, backupDirName, name)); err != nil {
		return false, err
	}
	for index, backup := range listBackups(projectDir) {
		if index >= backupsKept {
			_ = os.Remove(filepath.Join(projectDir, backupDirName, backup.Name))
		}
	}
	return true, nil
}

func (s *Server) handleWorkspaceBackups(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.URL.Query().Get("workspace")
	projectDir, err := s.workspaceDataPath(workspaceID)
	if err != nil || !validWorkspaceID(workspaceID) {
		jsonError(w, "workspace is required", http.StatusBadRequest)
		return
	}
	jsonOK(w, listBackups(projectDir))
}

type restoreBackupReq struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
}

// handleWorkspaceRestoreBackup replaces a workspace's database with one of its
// backups. The current database is backed up first, so a restore can itself
// be undone. The app reopens the project afterwards.
func (s *Server) handleWorkspaceRestoreBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req restoreBackupReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validWorkspaceID(req.WorkspaceID) ||
		req.Name == "" || req.Name != filepath.Base(req.Name) || !strings.HasSuffix(req.Name, ".db") {
		jsonError(w, "workspaceId and a backup name are required", http.StatusBadRequest)
		return
	}
	projectDir, err := s.workspaceDataPath(req.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	source := filepath.Join(projectDir, backupDirName, req.Name)
	if _, err := os.Stat(source); err != nil {
		jsonError(w, "backup not found", http.StatusNotFound)
		return
	}
	if sqlDB, err := s.dbFor(req.WorkspaceID); err == nil {
		safety := filepath.Join(projectDir, backupDirName, fmt.Sprintf("before-restore-%s.db", time.Now().Format("20060102-150405")))
		if err := snapshotDatabase(sqlDB, safety); err != nil {
			jsonError(w, fmt.Sprintf("could not back up the current map first: %v", err), http.StatusInternalServerError)
			return
		}
	}
	s.closeDB(req.WorkspaceID)
	live := filepath.Join(projectDir, "axiom.db")
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(live + suffix)
	}
	if err := copyFile(source, live); err != nil {
		jsonError(w, fmt.Sprintf("restore backup: %v", err), http.StatusInternalServerError)
		return
	}
	log.Printf("[api] workspace %s restored from %s", req.WorkspaceID, req.Name)
	jsonOK(w, map[string]any{"restored": req.Name})
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	temp := target + ".restoring"
	out, err := os.OpenFile(temp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

// ─── Export and import ──────────────────────────────────────────────────────

type exportReq struct {
	WorkspaceID string            `json:"workspaceId"`
	Path        string            `json:"path"`
	Manifest    map[string]string `json:"manifest"`
}

// handleWorkspaceExport writes a map to a single file: a consistent snapshot
// of the workspace database plus a manifest table naming the project, its
// original folder and exclusions, so it can be reattached elsewhere.
func (s *Server) handleWorkspaceExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req exportReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validWorkspaceID(req.WorkspaceID) || !filepath.IsAbs(req.Path) {
		jsonError(w, "workspaceId and an absolute path are required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(req.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	if err := snapshotDatabase(sqlDB, req.Path); err != nil {
		jsonError(w, fmt.Sprintf("export: %v", err), http.StatusInternalServerError)
		return
	}
	exported, err := sql.Open("sqlite3", req.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer exported.Close()
	manifest := map[string]string{}
	for key, value := range req.Manifest {
		manifest[key] = value
	}
	manifest["workspaceId"] = req.WorkspaceID
	manifest["exportedAt"] = fmt.Sprint(time.Now().UnixMilli())
	manifest["schemaVersion"] = fmt.Sprint(db.SchemaVersion)
	if _, err := exported.Exec(`CREATE TABLE ` + exportManifest + ` (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for key, value := range manifest {
		if _, err := exported.Exec(`INSERT INTO `+exportManifest+` (key, value) VALUES (?, ?)`, key, value); err != nil {
			jsonError(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	jsonOK(w, map[string]any{"exported": req.Path})
}

type importReq struct {
	Path    string `json:"path"`
	Replace bool   `json:"replace"`
}

func readExportManifest(path string) (map[string]string, int, error) {
	file, err := sql.Open("sqlite3", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	var version int
	if err := file.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return nil, 0, fmt.Errorf("not an Axiom map file")
	}
	rows, err := file.Query(`SELECT key, value FROM ` + exportManifest)
	if err != nil {
		return nil, 0, fmt.Errorf("not an Axiom map file")
	}
	defer rows.Close()
	manifest := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, 0, err
		}
		manifest[key] = value
	}
	return manifest, version, rows.Err()
}

// handleWorkspaceImport installs an exported map under its own workspace id.
// It refuses maps from a newer Axiom, and an id that already exists unless
// the caller chose to replace it (the existing map goes to the trash).
func (s *Server) handleWorkspaceImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req importReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !filepath.IsAbs(req.Path) {
		jsonError(w, "an absolute path is required", http.StatusBadRequest)
		return
	}
	manifest, version, err := readExportManifest(req.Path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	if version > db.SchemaVersion {
		jsonError(w, db.ErrNewerSchema.Error(), http.StatusConflict)
		return
	}
	workspaceID := manifest["workspaceId"]
	projectDir, err := s.workspaceDataPath(workspaceID)
	if err != nil || !validWorkspaceID(workspaceID) {
		jsonError(w, "the map file has no valid project id", http.StatusBadRequest)
		return
	}
	replacedTrashPath := ""
	if _, err := os.Stat(filepath.Join(projectDir, "axiom.db")); err == nil {
		if !req.Replace {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "exists", "manifest": manifest})
			return
		}
		trashed, err := s.trashWorkspace(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		replacedTrashPath = trashed
	}
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	live := filepath.Join(projectDir, "axiom.db")
	if err := copyFile(req.Path, live); err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// The manifest describes the file, not the map; it does not belong inside.
	if imported, err := sql.Open("sqlite3", live); err == nil {
		_, _ = imported.Exec(`DROP TABLE IF EXISTS ` + exportManifest)
		imported.Close()
	}
	s.reviveWorkspace(workspaceID)
	log.Printf("[api] imported workspace %s from %s", workspaceID, req.Path)
	jsonOK(w, map[string]any{"manifest": manifest, "replacedTrashPath": replacedTrashPath})
}
