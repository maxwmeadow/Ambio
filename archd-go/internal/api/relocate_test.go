package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

func TestRelocateWorkspaceKeepsRootIdentityAndRebasesPaths(t *testing.T) {
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, runtime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "moved"}); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(t.TempDir(), "old")
	newPath := filepath.Join(t.TempDir(), "new")
	if err := os.MkdirAll(newPath, 0o755); err != nil {
		t.Fatal(err)
	}
	root := db.Root{
		ID: "root-1", WorkspaceID: "ws", Path: oldPath, IsPrimary: true,
		IgnoredPaths: []string{filepath.Join(oldPath, "vendor") + "/**", "/elsewhere/**"},
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertFile(sqlDB, db.File{
		ID: "f1", RootID: root.ID, Path: filepath.Join(oldPath, "src", "a.go"), RelPath: "src/a.go",
	}); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(relocateWorkspaceReq{WorkspaceID: "ws", FromPath: oldPath, ToPath: newPath})
	rec := httptest.NewRecorder()
	server.handleWorkspaceRelocate(rec, httptest.NewRequest(http.MethodPost, "/api/workspace-relocate", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}

	roots, err := db.GetRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0].ID != "root-1" || roots[0].Path != newPath {
		t.Fatalf("roots after relocate = %#v", roots)
	}
	if got, want := roots[0].IgnoredPaths[0], filepath.Join(newPath, "vendor")+"/**"; filepath.ToSlash(got) != filepath.ToSlash(want) {
		t.Fatalf("ignored path = %q, want %q", got, want)
	}
	if roots[0].IgnoredPaths[1] != "/elsewhere/**" {
		t.Fatalf("unrelated ignore pattern changed: %q", roots[0].IgnoredPaths[1])
	}
	files, err := db.GetFilesByRoot(sqlDB, "root-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Path != filepath.Join(newPath, "src", "a.go") {
		t.Fatalf("files after relocate = %#v", files)
	}
}

func TestRelocateWorkspaceRejectsMissingDestination(t *testing.T) {
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, runtime.NewManager(eventHub))
	body, _ := json.Marshal(relocateWorkspaceReq{WorkspaceID: "ws", FromPath: "/a", ToPath: filepath.Join(t.TempDir(), "nope")})
	rec := httptest.NewRecorder()
	server.handleWorkspaceRelocate(rec, httptest.NewRequest(http.MethodPost, "/api/workspace-relocate", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

func TestRebasePathLeavesOutsidePathsAlone(t *testing.T) {
	if got := db.RebasePath("/a/bc/x", "/a/b", "/z"); got != "/a/bc/x" {
		t.Fatalf("sibling prefix rebased: %q", got)
	}
}
