package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ambio.local/archd/internal/db"
)

func writeRepoFile(t *testing.T, repo, relPath, body string) {
	t.Helper()
	path := filepath.Join(repo, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func getBranchReview(t *testing.T, server *Server, query string) branchReview {
	t.Helper()
	response := httptest.NewRecorder()
	server.handleBranchReview(response, httptest.NewRequest(http.MethodGet, "/api/checkouts/review?workspace=ws"+query, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("review status = %d, body = %s", response.Code, response.Body.String())
	}
	var review branchReview
	if err := json.Unmarshal(response.Body.Bytes(), &review); err != nil {
		t.Fatal(err)
	}
	return review
}

func TestReviewingABranchWordsItsArchitecture(t *testing.T) {
	repo := t.TempDir()
	writeRepoFile(t, repo, "src/api/api.ts", "import { store } from '../storage/store'\nexport const api = () => store()\n")
	writeRepoFile(t, repo, "src/storage/store.ts", "export const store = () => 1\n")
	writeRepoFile(t, repo, "src/email/email.ts", "export const send = () => 2\n")
	runWorktreeGit(t, repo, "init", "-b", "main")
	runWorktreeGit(t, repo, "config", "user.email", "ambio-test@example.com")
	runWorktreeGit(t, repo, "config", "user.name", "Ambio Test")
	runWorktreeGit(t, repo, "add", ".")
	runWorktreeGit(t, repo, "commit", "-m", "base")
	agent := filepath.Join(t.TempDir(), "agent")
	runWorktreeGit(t, repo, "worktree", "add", "-b", "agent", agent)
	writeRepoFile(t, agent, "src/api/api.ts", "import { send } from '../email/email'\nexport const api = () => send()\n")
	writeRepoFile(t, agent, "src/api/retry.ts", "import { api } from './api'\nexport const retry = () => api()\n")

	server := openCheckoutServer(t, t.TempDir(), repo)
	t.Cleanup(func() { server.closeDB("ws") })
	settleCheckout(server)
	sqlDB, _ := server.dbFor("ws")
	// Names the clusterer would not choose for these folders.
	for _, system := range []string{"Gateway", "Vault", "Mailer"} {
		if err := db.UpsertSystem(sqlDB, db.System{ID: "sys_" + strings.ToLower(system), WorkspaceID: "ws", Name: system, Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	for relPath, system := range map[string]string{"src/api/api.ts": "sys_gateway", "src/storage/store.ts": "sys_vault", "src/email/email.ts": "sys_mailer"} {
		if _, err := sqlDB.Exec(`UPDATE files SET system_id=? WHERE rel_path=?`, system, relPath); err != nil {
			t.Fatal(err)
		}
	}

	agentRoot := ""
	for _, checkout := range getCheckouts(t, server).Checkouts {
		if checkout.Branch == "agent" {
			agentRoot = checkout.RootID
		}
	}
	review := getBranchReview(t, server, "&root="+agentRoot)
	titles := make([]string, 0, len(review.Claims))
	for _, claim := range review.Claims {
		titles = append(titles, claim.Title)
	}
	t.Logf("claims: %q", titles)
	if review.Base != "main" || review.Files != 2 {
		t.Fatalf("review = base %q, %d files", review.Base, review.Files)
	}
	joined := strings.Join(titles, "\n")
	for _, want := range []string{"Mailer", "Vault"} {
		if !strings.Contains(joined, want) {
			t.Errorf("claims never mention %s: %q", want, titles)
		}
	}

	// The Floor's own branch is compared with the default branch: here it is
	// the default branch, so there is nothing to review.
	own := getBranchReview(t, server, "")
	if own.Files != 0 || own.Message == "" {
		t.Fatalf("main against itself = %#v", own)
	}
}
