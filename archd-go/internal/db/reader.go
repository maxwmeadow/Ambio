package db

import "database/sql"

// Reader allows related reads to share one transaction and snapshot.
type Reader interface {
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}
