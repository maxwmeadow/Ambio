package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"ambio.local/archd/internal/db"
)

func sourceFile(t *testing.T, s *Server, root, id, rel string, content []byte) string {
	t.Helper()
	d, _ := s.dbFor("ws")
	path := filepath.Join(root, rel)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertFile(d, db.File{ID: id, RootID: "root", Path: path, RelPath: rel, Language: "python"}); err != nil {
		t.Fatal(err)
	}
	return path
}

func readSource(t *testing.T, mux http.Handler, id string) fileSourceResponse {
	t.Helper()
	r := inboxHTTP(t, mux, "GET", "/api/files/"+id+"/source?workspace=ws", nil)
	var source fileSourceResponse
	if err := json.Unmarshal(r.Body.Bytes(), &source); err != nil || r.Code != 200 {
		t.Fatal(r.Code, r.Body.String(), err)
	}
	return source
}

func TestSaveSourceWritesAnEditMadeAgainstTheCurrentFile(t *testing.T) {
	s, mux, root := inboxServer(t)
	path := sourceFile(t, s, root, "heur", "heuristics.py", []byte("speed = 0.1\r\nmoving = speed > 0.1\r\n"))
	opened := readSource(t, mux, "heur")
	if !opened.Editable || opened.Hash != contentHash([]byte("speed = 0.1\r\nmoving = speed > 0.1\r\n")) {
		t.Fatalf("source = %+v", opened)
	}

	edit := "speed = 0.1\r\nmoving = speed > config.threshold\r\n"
	saved := inboxHTTP(t, mux, "PUT", "/api/files/heur/source", map[string]any{"workspaceId": "ws", "content": edit, "baseHash": opened.Hash})
	if saved.Code != 200 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	var result fileSourceResponse
	_ = json.Unmarshal(saved.Body.Bytes(), &result)
	// Line endings are the editor's to keep: the bytes written are the bytes sent.
	if disk, _ := os.ReadFile(path); string(disk) != edit || result.Hash != contentHash([]byte(edit)) {
		t.Fatalf("disk = %q, result = %+v", disk, result)
	}
}

func TestSaveSourceRefusesAnEditMadeAgainstAnOlderFile(t *testing.T) {
	s, mux, root := inboxServer(t)
	path := sourceFile(t, s, root, "heur", "heuristics.py", []byte("a = 1\n"))
	opened := readSource(t, mux, "heur")
	// An agent writes the file while the person is editing.
	if err := os.WriteFile(path, []byte("a = 2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	saved := inboxHTTP(t, mux, "PUT", "/api/files/heur/source", map[string]any{"workspaceId": "ws", "content": "a = 3\n", "baseHash": opened.Hash})
	if saved.Code != http.StatusConflict {
		t.Fatal(saved.Code, saved.Body.String())
	}
	var conflict struct{ Current fileSourceResponse }
	_ = json.Unmarshal(saved.Body.Bytes(), &conflict)
	if conflict.Current.Content != "a = 2\n" || conflict.Current.Hash != contentHash([]byte("a = 2\n")) {
		t.Fatalf("conflict = %+v", conflict)
	}
	if disk, _ := os.ReadFile(path); string(disk) != "a = 2\n" {
		t.Fatalf("the agent's write was overwritten: %q", disk)
	}
}

func TestSaveSourceRefusesWhatItCannotWriteFaithfully(t *testing.T) {
	s, mux, root := inboxServer(t)
	binary := []byte{'a', 0xff, 0xfe, '\n'}
	sourceFile(t, s, root, "bin", "blob.py", binary)
	opened := readSource(t, mux, "bin")
	if opened.Editable {
		t.Fatal("non-UTF-8 bytes were offered for editing")
	}
	if r := inboxHTTP(t, mux, "PUT", "/api/files/bin/source", map[string]any{"workspaceId": "ws", "content": "a\n", "baseHash": contentHash(binary)}); r.Code != http.StatusUnsupportedMediaType {
		t.Fatal(r.Code, r.Body.String())
	}
	// Saving names a file by ID, never by a path that might match another file.
	sourceFile(t, s, root, "heur", "heuristics.py", []byte("a\n"))
	if r := inboxHTTP(t, mux, "PUT", "/api/files/heuristics.py/source", map[string]any{"workspaceId": "ws", "content": "b\n", "baseHash": contentHash([]byte("a\n"))}); r.Code != 404 {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := inboxHTTP(t, mux, "PUT", "/api/files/heur/source", map[string]any{"workspaceId": "ws", "content": "b\n"}); r.Code != 400 {
		t.Fatal(r.Code, r.Body.String())
	}
}

func TestSaveSourceNeverWritesThroughALinkOutOfTheProject(t *testing.T) {
	s, mux, root := inboxServer(t)
	outside := filepath.Join(t.TempDir(), "secret.py")
	if err := os.WriteFile(outside, []byte("x\n"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.py")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	d, _ := s.dbFor("ws")
	if err := db.UpsertFile(d, db.File{ID: "linked", RootID: "root", Path: link, RelPath: "linked.py", Language: "python"}); err != nil {
		t.Fatal(err)
	}
	r := inboxHTTP(t, mux, "PUT", "/api/files/linked/source", map[string]any{"workspaceId": "ws", "content": "y\n", "baseHash": contentHash([]byte("x\n"))})
	if r.Code != http.StatusForbidden {
		t.Fatal(r.Code, r.Body.String())
	}
	if disk, _ := os.ReadFile(outside); string(disk) != "x\n" {
		t.Fatalf("wrote outside the project: %q", disk)
	}
}
