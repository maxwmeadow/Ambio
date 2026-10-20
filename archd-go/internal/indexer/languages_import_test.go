package indexer

import (
	"sort"
	"strings"
	"testing"

	"ambio.local/archd/internal/db"
	"ambio.local/archd/internal/hub"
)

// Every language Ambio reads links a file to the project files it imports,
// by that language's own rule - and to nothing for a dependency outside the
// project (stdio.h, java.util, serde, json, Foundation).
func TestImportLinksInEveryLanguage(t *testing.T) {
	projectDir := t.TempDir()
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	fixture := map[string]string{
		// C
		"c/src/main.c":                  "#include \"util/str.h\"\n#include <stdio.h>\nint main(void) { return str_len(\"x\"); }\n",
		"c/src/util/str.h":              "int str_len(const char *s);\n",
		"c/src/util/str.c":              "#include \"str.h\"\nint str_len(const char *s) { return 0; }\n",
		"cpp/src/app.cpp":               "#include <engine/render.hpp>\nint main() { return 0; }\n",
		"cpp/include/engine/render.hpp": "namespace engine { void draw(); }\n",
		// Java and Kotlin
		"jvm/src/main/java/com/acme/App.java":        "package com.acme;\nimport com.acme.core.Money;\nimport com.acme.util.*;\nimport java.util.List;\nclass App {}\n",
		"jvm/src/main/java/com/acme/core/Money.java": "package com.acme.core;\npublic class Money {}\n",
		"jvm/src/main/java/com/acme/util/Fmt.java":   "package com.acme.util;\npublic class Fmt {}\n",
		"jvm/src/main/java/com/acme/util/Pct.java":   "package com.acme.util;\npublic class Pct {}\n",
		"jvm/src/main/kotlin/com/acme/Invoice.kt":    "package com.acme\nimport com.acme.core.Money\nclass Invoice(val total: Money)\n",
		// Rust
		"rs/src/lib.rs":         "mod db;\nmod billing;\npub fn run() {}\n",
		"rs/src/db.rs":          "use crate::billing::Invoice;\nuse serde::Serialize;\npub fn open() {}\n",
		"rs/src/billing/mod.rs": "pub mod tax;\npub struct Invoice;\n",
		"rs/src/billing/tax.rs": "use super::Invoice;\npub fn rate() {}\n",
		// Ruby
		"rb/app/jobs/upload.rb": "require_relative '../models/user'\nrequire 'json'\nclass Upload; end\n",
		"rb/app/models/user.rb": "class User; end\n",
		// PHP
		"php/src/Billing/Invoice.php": "<?php\nnamespace App\\Billing;\nuse App\\Models\\User;\nrequire_once __DIR__ . '/helpers.php';\nclass Invoice {}\n",
		"php/src/Billing/helpers.php": "<?php\nfunction money() {}\n",
		"php/src/Models/User.php":     "<?php\nnamespace App\\Models;\nclass User {}\n",
		// Swift
		"swift/Sources/App/main.swift":            "import Foundation\nimport BillingCore\nfunc run() {}\n",
		"swift/Sources/BillingCore/Invoice.swift": "struct Invoice {}\n",
		"swift/Sources/BillingCore/Tax.swift":     "struct Tax {}\n",
		// Scala and Groovy: JVM class imports
		"jvm/src/main/scala/com/acme/Report.scala":  "package com.acme\nimport com.acme.core.{Money, Missing => Gone}\nimport com.acme.util._\nimport scala.collection.mutable\nobject Report { def run(): Unit = () }\n",
		"jvm/src/main/groovy/com/acme/Build.groovy": "package com.acme\nimport com.acme.core.Money\nimport static com.acme.util.Fmt.format\nclass Build { def go() { 1 } }\n",
		// Lua
		"lua/main.lua":           "local util = require('shop.util')\nlocal cart = require \"shop.cart\"\nlocal json = require('cjson')\nprint(util)\n",
		"lua/shop/util.lua":      "local M = {}\nfunction M.trim(s) return s end\nreturn M\n",
		"lua/shop/cart/init.lua": "local M = {}\nfunction M:add(x) end\nreturn M\n",
		// Shell
		"sh/deploy.sh":     "#!/bin/bash\nsource ./lib/common.sh\n. \"$(dirname \"$0\")/lib/log.sh\"\nsource /etc/profile\nrun() { echo 1; }\n",
		"sh/lib/common.sh": "die() { exit 1; }\n",
		"sh/lib/log.sh":    "function log { echo \"$1\"; }\n",
		// Elixir
		"ex/lib/shop/checkout.ex":     "defmodule Shop.Checkout do\n  alias Shop.Models.{Cart, Order}\n  import Shop.HTTPClient\n  require Logger\n  def total(%Cart{} = c), do: 1\n  defp helper(x) when x > 0 do\n    x\n  end\nend\n",
		"ex/lib/shop/models/cart.ex":  "defmodule Shop.Models.Cart do\n  defstruct [:items]\nend\n",
		"ex/lib/shop/models/order.ex": "defmodule Shop.Models.Order do\n  defstruct [:id]\nend\n",
		"ex/lib/shop/http_client.ex":  "defmodule Shop.HTTPClient do\n  def get(url), do: url\nend\n",
	}
	for relPath, content := range fixture {
		writeFixtureFile(t, projectDir, relPath, content)
	}
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: projectDir}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "languages"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := IndexRoot(sqlDB, hub.New(), root, nil); err != nil {
		t.Fatal(err)
	}
	files, _ := db.GetFilesByRoot(sqlDB, root.ID)
	relOf := map[string]string{}
	for _, f := range files {
		relOf[f.ID] = f.RelPath
	}
	if len(files) != len(fixture) {
		t.Errorf("every file is indexed: %d of %d", len(files), len(fixture))
	}
	deps, _ := db.GetDependenciesByRoot(sqlDB, root.ID)
	imports := map[string][]string{}
	for _, d := range deps {
		if d.DependencyType == "IMPORTS" {
			imports[relOf[d.Src]] = append(imports[relOf[d.Src]], relOf[d.Dst])
		}
	}
	for from := range imports {
		sort.Strings(imports[from])
	}
	want := map[string][]string{
		"c/src/main.c":                              {"c/src/util/str.h"},
		"c/src/util/str.c":                          {"c/src/util/str.h"},
		"cpp/src/app.cpp":                           {"cpp/include/engine/render.hpp"},
		"jvm/src/main/java/com/acme/App.java":       {"jvm/src/main/java/com/acme/core/Money.java", "jvm/src/main/java/com/acme/util/Fmt.java", "jvm/src/main/java/com/acme/util/Pct.java"},
		"jvm/src/main/kotlin/com/acme/Invoice.kt":   {"jvm/src/main/java/com/acme/core/Money.java"},
		"rs/src/lib.rs":                             {"rs/src/billing/mod.rs", "rs/src/db.rs"},
		"rs/src/db.rs":                              {"rs/src/billing/mod.rs"},
		"rs/src/billing/mod.rs":                     {"rs/src/billing/tax.rs"},
		"rs/src/billing/tax.rs":                     {"rs/src/billing/mod.rs"},
		"rb/app/jobs/upload.rb":                     {"rb/app/models/user.rb"},
		"php/src/Billing/Invoice.php":               {"php/src/Billing/helpers.php", "php/src/Models/User.php"},
		"swift/Sources/App/main.swift":              {"swift/Sources/BillingCore/Invoice.swift", "swift/Sources/BillingCore/Tax.swift"},
		"jvm/src/main/scala/com/acme/Report.scala":  {"jvm/src/main/java/com/acme/core/Money.java", "jvm/src/main/java/com/acme/util/Fmt.java", "jvm/src/main/java/com/acme/util/Pct.java"},
		"jvm/src/main/groovy/com/acme/Build.groovy": {"jvm/src/main/java/com/acme/core/Money.java", "jvm/src/main/java/com/acme/util/Fmt.java"},
		"lua/main.lua":                              {"lua/shop/cart/init.lua", "lua/shop/util.lua"},
		"sh/deploy.sh":                              {"sh/lib/common.sh", "sh/lib/log.sh"},
		"ex/lib/shop/checkout.ex":                   {"ex/lib/shop/http_client.ex", "ex/lib/shop/models/cart.ex", "ex/lib/shop/models/order.ex"},
	}
	for from, targets := range want {
		if strings.Join(imports[from], " ") != strings.Join(targets, " ") {
			t.Errorf("%s imports %v, got %v", from, targets, imports[from])
		}
	}
	for from, got := range imports {
		if _, expected := want[from]; !expected {
			t.Errorf("unexpected imports from %s: %v", from, got)
		}
	}
}
