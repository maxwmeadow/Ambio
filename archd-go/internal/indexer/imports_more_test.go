package indexer

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
)

// Java, Rust, Ruby and C++ files get import edges, so they cluster by what
// they use rather than by name alone.
func TestImportEdgesForJavaRustRubyCpp(t *testing.T) {
	sqlDB, root, _ := journalFixture(t)
	files := map[string]string{
		"java/src/main/java/shop/orders/Cart.java":     "package shop.orders;\nimport shop.payments.Stripe;\nimport shop.billing.*;\nimport java.util.List;\nclass Cart {}\n",
		"java/src/main/java/shop/payments/Stripe.java": "package shop.payments;\nclass Stripe {}\n",
		"java/src/main/java/shop/billing/Invoice.java": "package shop.billing;\nclass Invoice {}\n",
		"java/src/main/java/shop/billing/Tax.java":     "package shop.billing;\nclass Tax {}\n",
		"rust/src/lib.rs":             "mod orders;\nmod payments;\n",
		"rust/src/orders/mod.rs":      "use crate::payments::stripe::Client;\nuse std::fmt;\npub fn place() {}\n",
		"rust/src/payments/mod.rs":    "pub mod stripe;\n",
		"rust/src/payments/stripe.rs": "pub struct Client;\n",
		"ruby/lib/shop/order.rb":      "require 'shop/payment'\nrequire_relative 'line_item'\nrequire 'json'\nclass Order; end\n",
		"ruby/lib/shop/payment.rb":    "class Payment; end\n",
		"ruby/lib/shop/line_item.rb":  "class LineItem; end\n",
		"cpp/src/cart.cpp":            "#include \"cart.h\"\n#include \"payments/stripe.h\"\n#include <vector>\nint total() { return 0; }\n",
		"cpp/src/payments/stripe.cpp": "#include \"stripe.h\"\nint charge() { return 1; }\n",
	}
	for rel, body := range files {
		abs := filepath.Join(root.Path, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := IndexRoot(sqlDB, hub.New(), root, nil); err != nil {
		t.Fatal(err)
	}
	indexed, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	pathOf := map[string]string{}
	for _, file := range indexed {
		pathOf[file.ID] = file.RelPath
	}
	deps, err := db.GetDependencies(sqlDB, root.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, dep := range deps {
		if dep.DependencyType == "IMPORTS" {
			got = append(got, pathOf[dep.Src]+" → "+pathOf[dep.Dst])
		}
	}
	sort.Strings(got)
	want := []string{
		"cpp/src/cart.cpp → cpp/src/payments/stripe.cpp",
		"java/src/main/java/shop/orders/Cart.java → java/src/main/java/shop/billing/Invoice.java",
		"java/src/main/java/shop/orders/Cart.java → java/src/main/java/shop/billing/Tax.java",
		"java/src/main/java/shop/orders/Cart.java → java/src/main/java/shop/payments/Stripe.java",
		"ruby/lib/shop/order.rb → ruby/lib/shop/line_item.rb",
		"ruby/lib/shop/order.rb → ruby/lib/shop/payment.rb",
		"rust/src/lib.rs → rust/src/orders/mod.rs",
		"rust/src/lib.rs → rust/src/payments/mod.rs",
		"rust/src/orders/mod.rs → rust/src/payments/stripe.rs",
		"rust/src/payments/mod.rs → rust/src/payments/stripe.rs",
	}
	if len(got) != len(want) {
		t.Fatalf("import edges:\n got %q\nwant %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("import edges:\n got %q\nwant %q", got, want)
		}
	}
}

// C is read too, headers included, and an include lands on the header itself.
func TestCFilesAndHeaders(t *testing.T) {
	sqlDB, root, _ := journalFixture(t)
	files := map[string]string{
		"src/cart.c":            "#include \"cart.h\"\n#include \"payments/stripe.h\"\n#include <stdio.h>\nint cart_total(int n) { return charge(n); }\n",
		"src/cart.h":            "int cart_total(int n);\n",
		"src/payments/stripe.h": "int charge(int amount);\n",
		"src/payments/stripe.c": "#include \"stripe.h\"\nint charge(int amount) { return amount; }\n",
	}
	for rel, body := range files {
		abs := filepath.Join(root.Path, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := IndexRoot(sqlDB, hub.New(), root, nil); err != nil {
		t.Fatal(err)
	}
	indexed, _ := db.GetFilesByRoot(sqlDB, root.ID)
	pathOf := map[string]string{}
	for _, file := range indexed {
		pathOf[file.ID] = file.RelPath
		if file.Language != "c" {
			t.Fatalf("%s indexed as %q", file.RelPath, file.Language)
		}
	}
	if len(indexed) != 4 {
		t.Fatalf("indexed %d files, want 4 (headers too)", len(indexed))
	}
	deps, _ := db.GetDependencies(sqlDB, root.WorkspaceID)
	got := []string{}
	for _, dep := range deps {
		if dep.DependencyType == "IMPORTS" {
			got = append(got, pathOf[dep.Src]+" → "+pathOf[dep.Dst])
		}
	}
	sort.Strings(got)
	want := []string{
		"src/cart.c → src/cart.h",
		"src/cart.c → src/payments/stripe.h",
		"src/payments/stripe.c → src/payments/stripe.h",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("include edges:\n got %q\nwant %q", got, want)
	}
	cart, _ := db.GetFileByRelPath(sqlDB, root.ID, "src/cart.c")
	symbols, _ := db.GetSymbolsByFile(sqlDB, cart.ID)
	if len(symbols) == 0 || symbols[0].Name != "cart_total" {
		t.Fatalf("C symbols = %+v", symbols)
	}
}
