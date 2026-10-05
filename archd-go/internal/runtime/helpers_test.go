package runtime

import (
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

func TestGoBreakpointNamesComeFromThePackageClause(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "store.go")
	if err := os.WriteFile(file, []byte("// Package store keeps carts.\npackage store // doc\n\nfunc Save() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := goPackageName(file); got != "store" {
		t.Fatalf("package = %q", got)
	}
	for _, tc := range []struct{ symbol, path, want string }{
		{"Save", file, "store.Save"},
		{"store.Save", file, "store.Save"},                   // already qualified
		{"Save", filepath.Join(dir, "gone.go"), "main.Save"}, // unreadable: main
		{"Save", "", "main.Save"},
	} {
		if got := qualifyGoFunc(tc.symbol, tc.path); got != tc.want {
			t.Fatalf("qualifyGoFunc(%q, %q) = %q, want %q", tc.symbol, tc.path, got, tc.want)
		}
	}
}

func TestGoFramesResolveToTheirWatchByPackageNotBareName(t *testing.T) {
	session := &DelveSession{funcToID: map[string]string{"store.Save": "w1", "main.Run": "w2"}}
	for frame, want := range map[string]string{
		"main.Run":                        "w2",
		"github.com/acme/shop/store.Save": "w1",
		"github.com/acme/shop/other.Save": "", // same bare name, other package
		"Save":                            "",
	} {
		if got := session.watchIDForGoFrame(normalizeGoFrameName(frame + " (0x1234)")); got != want {
			t.Fatalf("frame %q → %q, want %q", frame, got, want)
		}
	}
}

func TestTruncateRunesNeverSplitsACharacter(t *testing.T) {
	if got := truncateRunes("short", 10); got != "short" {
		t.Fatalf("got %q", got)
	}
	long := "ééééééééééé" // 11 runes, 22 bytes
	got := truncateRunes(long, 5)
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != 5 || got != "éééé…" {
		t.Fatalf("got %q", got)
	}
	if got := truncateRunes("éé", 3); got != "éé" {
		t.Fatalf("bytes over, runes under: got %q", got)
	}
}

func TestFreeTCPPortIsUsable(t *testing.T) {
	port, err := freeTCPPort()
	if err != nil || port <= 0 {
		t.Fatalf("port %d, err %v", port, err)
	}
}
