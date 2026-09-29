package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// proposedWorkspace opens a database holding one proposal that assigns two
// files, the state every project is in after onboarding.
func proposedWorkspace(t *testing.T) (*sql.DB, string) {
	t.Helper()
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	for _, file := range []*File{first, second} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	return database, created.ID
}

func TestDeletingAnOnboardedFileKeepsTheProposalRecord(t *testing.T) {
	database, proposalID := proposedWorkspace(t)
	if _, err := FinalizeArchitectureProposal(database, proposalID, "ws", 1, "user"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteFileByID(database, "file-a"); err != nil {
		t.Fatalf("a file a proposal assigned must still be deletable: %v", err)
	}
	var fileID sql.NullString
	var path string
	if err := database.QueryRow(`SELECT file_id,file_path FROM architecture_proposal_memberships WHERE proposal_id=? AND file_path='a.go'`, proposalID).Scan(&fileID, &path); err != nil {
		t.Fatalf("the proposal keeps its record of the deleted file: %v", err)
	}
	if fileID.Valid {
		t.Fatalf("the record no longer points at a file: %q", fileID.String)
	}
}

func TestAPendingProposalFinalizesAfterOneOfItsFilesIsDeleted(t *testing.T) {
	database, proposalID := proposedWorkspace(t)
	if err := DeleteFileByID(database, "file-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := FinalizeArchitectureProposal(database, proposalID, "ws", 1, "user"); err != nil {
		t.Fatalf("a deleted file has nothing to place and must not block the rest: %v", err)
	}
	var systemID sql.NullString
	if err := database.QueryRow(`SELECT system_id FROM files WHERE id='file-b'`).Scan(&systemID); err != nil || !systemID.Valid {
		t.Fatalf("the remaining file is placed: %v %v", systemID, err)
	}
}

func TestTheMembershipMigrationUpgradesAnExistingDatabase(t *testing.T) {
	database, proposalID := proposedWorkspace(t)
	// Put the table back the way databases created before the fix have it.
	ctx := context.Background()
	conn, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`PRAGMA foreign_keys=OFF`,
		`ALTER TABLE architecture_proposal_memberships RENAME TO memberships_saved`,
		`CREATE TABLE architecture_proposal_memberships (
			id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL,
			file_id TEXT REFERENCES files(id) ON DELETE SET NULL, root_id TEXT NOT NULL DEFAULT '',
			file_path TEXT NOT NULL, target_system_key TEXT NOT NULL DEFAULT '',
			disposition TEXT NOT NULL CHECK(disposition IN ('assign','retain','unassigned','excluded')),
			rationale TEXT NOT NULL DEFAULT '',
			FOREIGN KEY(proposal_id, revision) REFERENCES architecture_proposal_rounds(proposal_id, revision) ON DELETE CASCADE,
			UNIQUE(proposal_id, revision, file_path),
			CHECK(disposition != 'assign' OR (file_id IS NOT NULL AND length(target_system_key) > 0)))`,
		`INSERT INTO architecture_proposal_memberships SELECT * FROM memberships_saved`,
		`DROP TABLE memberships_saved`,
		`PRAGMA foreign_keys=ON`,
	} {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	_ = conn.Close()
	if err := DeleteFileByID(database, "file-a"); err == nil {
		t.Fatal("the old table should reproduce the bug")
	}

	if err := migrateProposalMembershipDeletes(database); err != nil {
		t.Fatal(err)
	}
	if err := migrateProposalMembershipDeletes(database); err != nil {
		t.Fatalf("running again is a no-op: %v", err)
	}
	var ddl string
	if err := database.QueryRow(`SELECT sql FROM sqlite_master WHERE name='architecture_proposal_memberships'`).Scan(&ddl); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ddl, "file_id IS NOT NULL AND") {
		t.Fatalf("the old CHECK survived: %s", ddl)
	}
	var rows int
	if err := database.QueryRow(`SELECT count(*) FROM architecture_proposal_memberships WHERE proposal_id=?`, proposalID).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("every membership is kept: %d %v", rows, err)
	}
	if err := DeleteFileByID(database, "file-a"); err != nil {
		t.Fatalf("after the migration the file deletes: %v", err)
	}
	var fk int
	if err := database.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign keys stay on for the pool: %d %v", fk, err)
	}
}
