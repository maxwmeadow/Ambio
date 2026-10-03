// Command schemagen writes the schema-upgrade fixtures in ../schema-v*.sql.
//
// It is run against an OLDER checkout of archd, so the map is written by that
// version's own code, and dumps the result as plain SQL that the current
// build's upgrade test replays (schema_upgrade_test.go). It lives in testdata
// so the current module never builds it. To regenerate a fixture:
//
//	git worktree add /tmp/ambio-old <commit>
//	mkdir -p /tmp/ambio-old/archd-go/cmd/schemagen
//	cp testdata/schemagen/main.go /tmp/ambio-old/archd-go/cmd/schemagen/
//	(cd /tmp/ambio-old/archd-go && go run ./cmd/schemagen) > testdata/schema-vN.sql
//
// Only functions that have existed since schema v0 are used.
package main

import (
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	"ambio.local/archd/internal/db"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func main() {
	dir, err := os.MkdirTemp("", "schemagen-")
	must(err)
	defer os.RemoveAll(dir)
	sqlDB, err := db.Open(dir)
	must(err)
	defer sqlDB.Close()

	orders, payments := "orders", "payments"
	must(db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "shop"}))
	must(db.UpsertRoot(sqlDB, db.Root{ID: "root", WorkspaceID: "ws", Path: "/fixture/shop", IsActive: true, IsPrimary: true}))
	must(db.UpsertSystem(sqlDB, db.System{ID: orders, WorkspaceID: "ws", Name: "Orders", Source: "user"}))
	must(db.UpsertSystem(sqlDB, db.System{ID: payments, WorkspaceID: "ws", Name: "Payments", Source: "cluster"}))
	must(db.UpsertFile(sqlDB, db.File{ID: "cart", RootID: "root", Path: "/fixture/shop/src/orders/cart.ts", RelPath: "src/orders/cart.ts", Language: "typescript", SystemID: &orders}))
	must(db.UpsertFile(sqlDB, db.File{ID: "stripe", RootID: "root", Path: "/fixture/shop/src/payments/stripe.ts", RelPath: "src/payments/stripe.ts", Language: "typescript", SystemID: &payments}))
	must(db.UpsertDependency(sqlDB, db.Dependency{ID: "cart->stripe", WorkspaceID: "ws", Src: "cart", Dst: "stripe", SrcType: "file", DstType: "file", DependencyType: "IMPORTS", Weight: 1, CreatedBy: "parser"}))
	must(db.CreateSheet(sqlDB, &db.Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Checkout"}))
	must(db.AddSheetElement(sqlDB, &db.SheetElement{SheetID: "sheet", SystemID: &orders, Label: "Orders"}))
	must(db.EnqueueCanvasMessage(sqlDB, &db.CanvasMessage{ID: "order", WorkspaceID: "ws", Note: "Split checkout"}))
	must(db.RecordStructuralEvent(sqlDB, db.StructuralEvent{WorkspaceID: "ws", Kind: db.EventFileCreated, SubjectID: "cart", SubjectLabel: "src/orders/cart.ts"}))
	must(dump(sqlDB))
}

func dump(sqlDB *sql.DB) error {
	var version int
	if err := sqlDB.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	fmt.Printf("-- Written by archd at schema v%d (testdata/schemagen). Do not edit.\n", version)
	fmt.Printf("PRAGMA user_version = %d;\n", version)
	rows, err := sqlDB.Query(`SELECT type, name, sql FROM sqlite_master
		WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
		ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`)
	if err != nil {
		return err
	}
	type object struct{ kind, name, sql string }
	var objects []object
	for rows.Next() {
		var o object
		if err := rows.Scan(&o.kind, &o.name, &o.sql); err != nil {
			return err
		}
		objects = append(objects, o)
	}
	rows.Close()
	for _, o := range objects {
		if o.kind == "table" {
			fmt.Printf("%s;\n", o.sql)
		}
	}
	for _, o := range objects {
		if o.kind != "table" {
			continue
		}
		data, err := sqlDB.Query(`SELECT * FROM "` + o.name + `"`)
		if err != nil {
			return err
		}
		columns, _ := data.Columns()
		for data.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := data.Scan(pointers...); err != nil {
				return err
			}
			literals := make([]string, len(values))
			for i, value := range values {
				literals[i] = literal(value)
			}
			fmt.Printf("INSERT INTO \"%s\" VALUES (%s);\n", o.name, strings.Join(literals, ", "))
		}
		data.Close()
	}
	for _, o := range objects {
		if o.kind != "table" {
			fmt.Printf("%s;\n", o.sql)
		}
	}
	return nil
}

func literal(value any) string {
	switch v := value.(type) {
	case nil:
		return "NULL"
	case int64:
		return fmt.Sprint(v)
	case float64:
		return fmt.Sprint(v)
	case []byte:
		return "X'" + hex.EncodeToString(v) + "'"
	case string:
		return "'" + strings.ReplaceAll(v, "'", "''") + "'"
	default:
		return "'" + strings.ReplaceAll(fmt.Sprint(v), "'", "''") + "'"
	}
}
