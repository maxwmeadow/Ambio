package db

import (
	"errors"
	"fmt"
	"testing"
)

func TestOpenStampsSchemaVersionAndRefusesNewerDatabases(t *testing.T) {
	dir := t.TempDir()
	sqlDB, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var version int
	if err := sqlDB.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", version, SchemaVersion)
	}
	if _, err := sqlDB.Exec(fmt.Sprintf("PRAGMA user_version = %d", SchemaVersion+1)); err != nil {
		t.Fatal(err)
	}
	sqlDB.Close()

	if _, err := Open(dir); !errors.Is(err, ErrNewerSchema) {
		t.Fatalf("opening a newer database: err = %v, want ErrNewerSchema", err)
	}
}
