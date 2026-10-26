package api

import (
	"path/filepath"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/indexer"
)

// Two repositories whose files share a vocabulary (payments, orders) would
// cluster together if the classifier saw one folder. Each must stay under its
// own repository's frame.
func newRepositoriesFolder(t *testing.T) string {
	t.Helper()
	parent := t.TempDir()
	files := map[string]map[string]string{
		"web": {
			"src/payment.ts":  "import { order } from './order'\nexport const paymentForm = () => order()\n",
			"src/order.ts":    "import { cart } from './cart'\nexport const order = () => cart()\n",
			"src/cart.ts":     "export const cart = () => 1\n",
			"src/checkout.ts": "import { paymentForm } from './payment'\nexport const checkout = () => paymentForm()\n",
		},
		"api": {
			"src/payment.ts": "import { invoice } from './invoice'\nexport const paymentCharge = () => invoice()\n",
			"src/order.ts":   "import { paymentCharge } from './payment'\nexport const orderCreate = () => paymentCharge()\n",
			"src/invoice.ts": "export const invoice = () => 2\n",
			"src/refund.ts":  "import { paymentCharge } from './payment'\nexport const refund = () => paymentCharge()\n",
		},
	}
	for repo, contents := range files {
		dir := filepath.Join(parent, repo)
		for relPath, body := range contents {
			writeRepoFile(t, dir, relPath, body)
		}
		runWorktreeGit(t, dir, "init", "-b", "main")
		runWorktreeGit(t, dir, "config", "user.email", "ambio-test@example.com")
		runWorktreeGit(t, dir, "config", "user.name", "Ambio Test")
		runWorktreeGit(t, dir, "add", ".")
		runWorktreeGit(t, dir, "commit", "-m", "base")
	}
	writeRepoFile(t, parent, "tools/release.ts", "export const release = () => 3\n")
	return parent
}

func TestEachRepositoryIsClusteredUnderItsOwnFrame(t *testing.T) {
	parent := newRepositoriesFolder(t)
	server := openCheckoutServer(t, t.TempDir(), parent)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	sqlDB, _ := server.dbFor("ws")
	waitForWorktreeTest(t, "repository frames", func() bool {
		return !indexer.NeedsRepositoryFrames(sqlDB, server.mustRoot(t))
	})

	systems, err := db.GetSystems(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]db.System{}
	frames := map[string]string{}
	for _, system := range systems {
		byID[system.ID] = system
		if system.Kind == indexer.RepositorySystemKind {
			if system.ParentID != nil {
				t.Errorf("frame %s is nested", system.Name)
			}
			frames[system.ID] = system.Name
		}
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %v, want web and api", frames)
	}
	frameOf := func(systemID string) string {
		for id := systemID; id != ""; {
			if name, ok := frames[id]; ok {
				return name
			}
			system := byID[id]
			if system.ParentID == nil {
				return ""
			}
			id = *system.ParentID
		}
		return ""
	}
	files, err := db.GetFilesByRoot(sqlDB, server.focusedRootID(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		want := ""
		switch {
		case len(file.RelPath) > 4 && file.RelPath[:4] == "web/":
			want = "web"
		case len(file.RelPath) > 4 && file.RelPath[:4] == "api/":
			want = "api"
		}
		got := ""
		if file.SystemID != nil {
			got = frameOf(*file.SystemID)
		}
		if got != want {
			t.Errorf("%s sits under %q, want %q", file.RelPath, got, want)
		}
	}
}

// A map made before repository frames existed gains them on its next open.
func TestAMapFromBeforeFramesGainsThemWhenReopened(t *testing.T) {
	parent := newRepositoriesFolder(t)
	dataDir := t.TempDir()
	first := openCheckoutServer(t, dataDir, parent)
	settleCheckout(first)
	firstDB, _ := first.dbFor("ws")
	waitForWorktreeTest(t, "repository frames", func() bool {
		return !indexer.NeedsRepositoryFrames(firstDB, first.mustRoot(t))
	})
	if _, err := firstDB.Exec(`DELETE FROM systems WHERE kind = ?`, indexer.RepositorySystemKind); err != nil {
		t.Fatal(err)
	}
	first.closeDB("ws")

	server := openCheckoutServer(t, dataDir, parent)
	t.Cleanup(func() { server.closeDB("ws") })
	sqlDB, _ := server.dbFor("ws")
	waitForWorktreeTest(t, "frames after reopening", func() bool {
		return !indexer.NeedsRepositoryFrames(sqlDB, server.mustRoot(t))
	})
}

func (s *Server) mustRoot(t *testing.T) db.Root {
	t.Helper()
	sqlDB, _ := s.dbFor("ws")
	rootID := s.focusedRootID(t)
	roots, err := db.GetActiveRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range roots {
		if root.ID == rootID {
			return root
		}
	}
	t.Fatal("the Floor's root is gone")
	return db.Root{}
}
