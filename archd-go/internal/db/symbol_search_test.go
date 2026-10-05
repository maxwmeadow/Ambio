package db

import (
	"path/filepath"
	"testing"
)

func TestSearchSymbolsRanksExactThenPrefixThenContains(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	for _, ws := range []string{"ws", "other"} {
		if err := UpsertWorkspace(sqlDB, Workspace{ID: ws, Name: ws}); err != nil {
			t.Fatal(err)
		}
		rootPath := t.TempDir()
		if err := UpsertRoot(sqlDB, Root{ID: "root-" + ws, WorkspaceID: ws, Path: rootPath}); err != nil {
			t.Fatal(err)
		}
		file := File{ID: "file-" + ws, RootID: "root-" + ws, Path: filepath.Join(rootPath, "a.ts"), RelPath: "src/a.ts", Language: "typescript"}
		if err := UpsertFile(sqlDB, file); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSymbols(sqlDB, file.ID, []Symbol{
			{ID: ws + "1", Name: "loadUserProfile", Kind: "function", LineStart: 1, LineEnd: 2},
			{ID: ws + "2", Name: "UserStore", Kind: "class", LineStart: 3, LineEnd: 9},
			{ID: ws + "3", Name: "user", Kind: "variable", LineStart: 10, LineEnd: 10},
			{ID: ws + "4", Name: "user_id", Kind: "variable", LineStart: 11, LineEnd: 11},
			{ID: ws + "5", Name: "render", Kind: "function", LineStart: 12, LineEnd: 20},
		}); err != nil {
			t.Fatal(err)
		}
	}

	hits, err := SearchSymbols(sqlDB, "ws", "User", 10)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, hit := range hits {
		names = append(names, hit.Name)
		if hit.RelPath != "src/a.ts" || hit.FileID != "file-ws" {
			t.Fatalf("hit from the wrong file or workspace: %+v", hit)
		}
	}
	want := []string{"user", "user_id", "UserStore", "loadUserProfile"}
	if len(names) != len(want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("names = %v, want %v", names, want)
		}
	}

	// LIKE wildcards in the query are literal.
	hits, err = SearchSymbols(sqlDB, "ws", "_", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Name != "user_id" {
		t.Fatalf("underscore search = %+v", hits)
	}
	if hits, _ := SearchSymbols(sqlDB, "ws", "  ", 10); len(hits) != 0 {
		t.Fatalf("blank query found %d symbols", len(hits))
	}
}
