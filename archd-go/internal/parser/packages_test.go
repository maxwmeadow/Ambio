package parser

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func parseSource(t *testing.T, name, source string) *Result {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := ParseFile(path, name)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func packages(result *Result) []string {
	var out []string
	for _, ref := range result.Packages {
		out = append(out, ref.Package)
	}
	sort.Strings(out)
	return out
}

func TestEveryWayJavaScriptLoadsAPackageIsEvidence(t *testing.T) {
	result := parseSource(t, "src/infra/db/index.ts", `import pg from 'pg'
import { S3Client } from '@aws-sdk/client-s3/dist-cjs'
import { readFileSync } from 'node:fs'
import { join } from 'path'
export { Resend } from 'resend'
const Redis = require('ioredis')
export async function db() {
  const adapter = await import('./postgres.ts')
  const stripe = await import('stripe')
  const computed = await import(name)
  return adapter
}
`)
	want := []string{"@aws-sdk/client-s3", "ioredis", "pg", "resend", "stripe"}
	if got := packages(result); !reflect.DeepEqual(got, want) {
		t.Fatalf("packages %v, want %v (built-ins and computed specifiers are not evidence)", got, want)
	}
	lines := map[string]int{}
	for _, ref := range result.Packages {
		lines[ref.Package] = ref.Line
	}
	if lines["pg"] != 1 || lines["ioredis"] != 6 || lines["stripe"] != 9 {
		t.Errorf("each package carries its line: %v", lines)
	}
	found := false
	for _, imp := range result.Imports {
		if imp == "src/infra/db/postgres.ts" {
			found = true
		}
	}
	if !found {
		t.Errorf("a lazily imported adapter is part of the file graph: %v", result.Imports)
	}
}

func TestPythonAndGoPackages(t *testing.T) {
	py := parseSource(t, "app/billing.py", `import os
import stripe, boto3.session
from redis.asyncio import Redis
from .models import Invoice
import psycopg2 as pg
`)
	if got := packages(py); !reflect.DeepEqual(got, []string{"boto3.session", "os", "psycopg2", "redis.asyncio", "stripe"}) {
		t.Errorf("python packages: %v", got)
	}
	golang := parseSource(t, "store/pg.go", `package store

import (
	"database/sql"
	"fmt"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"
)
`)
	if got := packages(golang); !reflect.DeepEqual(got, []string{"github.com/lib/pq", "github.com/redis/go-redis/v9"}) {
		t.Errorf("go packages (standard library excluded): %v", got)
	}
}

func TestEnvReadsAreNamesWithTheirLines(t *testing.T) {
	js := parseSource(t, "src/config/env.ts", `export const env = {
  databaseUrl: process.env.DATABASE_URL,
  key: process.env['STRIPE_SECRET_KEY'],
  vite: import.meta.env.VITE_API,
  port: Number(process.env.PORT ?? 3000),
}
`)
	got := map[string]int{}
	for _, ref := range js.EnvReads {
		got[ref.Name] = ref.Line
	}
	want := map[string]int{"DATABASE_URL": 2, "STRIPE_SECRET_KEY": 3, "VITE_API": 4, "PORT": 5}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("js env reads %v, want %v", got, want)
	}
	py := parseSource(t, "settings.py", "import os\nURL = os.environ['DATABASE_URL']\nKEY = os.getenv(\"OPENAI_API_KEY\")\n")
	if len(py.EnvReads) != 2 {
		t.Errorf("python env reads: %+v", py.EnvReads)
	}
	golang := parseSource(t, "main.go", "package main\nimport \"os\"\nvar dsn = os.Getenv(\"DATABASE_URL\")\n")
	if len(golang.EnvReads) != 1 || golang.EnvReads[0].Line != 3 {
		t.Errorf("go env reads: %+v", golang.EnvReads)
	}
}

func TestJavaCSharpRubyRustPackagesAndEnv(t *testing.T) {
	java := parseSource(t, "src/main/java/app/Billing.java", "package app;\nimport java.util.List;\nimport com.stripe.Stripe;\nimport static io.sentry.Sentry.captureException;\nclass Billing { String k = System.getenv(\"STRIPE_SECRET_KEY\"); }\n")
	if got := packages(java); !reflect.DeepEqual(got, []string{"com.stripe.Stripe", "io.sentry.Sentry.captureException"}) {
		t.Errorf("java packages: %v", got)
	}
	if len(java.EnvReads) != 1 || java.EnvReads[0].Name != "STRIPE_SECRET_KEY" {
		t.Errorf("java env: %+v", java.EnvReads)
	}
	cs := parseSource(t, "Cache.cs", "using System;\nusing StackExchange.Redis;\nclass C { var u = Environment.GetEnvironmentVariable(\"REDIS_URL\"); }\n")
	if got := packages(cs); !reflect.DeepEqual(got, []string{"StackExchange.Redis"}) {
		t.Errorf("c# packages: %v", got)
	}
	rb := parseSource(t, "app/jobs/upload.rb", "require 'aws-sdk-s3'\nrequire \"json\"\nBUCKET = ENV.fetch('S3_BUCKET')\n")
	if got := packages(rb); !reflect.DeepEqual(got, []string{"aws-sdk-s3", "json"}) {
		t.Errorf("ruby packages: %v", got)
	}
	rs := parseSource(t, "src/cache.rs", "use std::env;\nuse redis::Commands;\nuse crate::config;\nfn url() -> String { env::var(\"REDIS_URL\").unwrap() }\n")
	if got := packages(rs); !reflect.DeepEqual(got, []string{"redis"}) {
		t.Errorf("rust packages: %v", got)
	}
}

func TestTextImportsPerLanguage(t *testing.T) {
	cases := map[string]struct {
		source string
		want   []string
	}{
		// Java, Rust, Ruby and quoted C/C++ includes are read by imports_more.go
		// (imports_more_test.go); C adds <dir/file.h> project headers here.
		"src/net/conn.c":         {"#include \"util/str.h\"\n#include <stdio.h>\n", []string{"inc<stdio.h"}},
		"src/Invoice.kt":         {"package a\nimport com.acme.core.Money\nimport com.acme.util.*\nimport com.acme.x.Y as Z\n", []string{"jvm:com.acme.core.Money", "jvm:com.acme.util.*", "jvm:com.acme.x.Y"}},
		"src/Billing/Inv.php":    {"<?php\nuse App\\Models\\User;\nuse App\\Support\\{Money, Fmt as F};\nrequire_once __DIR__ . '/helpers.php';\n", []string{"php-file:/helpers.php", `php-ns:App\Models\User`, `php-ns:App\Support\Money`, `php-ns:App\Support\Fmt`}},
		"Sources/App/main.swift": {"import Foundation\n@testable import BillingCore\n", []string{"swift:Foundation", "swift:BillingCore"}},
	}
	for name, c := range cases {
		r := parseSource(t, name, c.source)
		got := map[string]bool{}
		for _, spec := range r.Imports {
			got[spec] = true
		}
		for _, w := range c.want {
			if !got[w] {
				t.Errorf("%s: missing %q in %q", name, w, r.Imports)
			}
		}
	}
}

func TestSymbolsInNewLanguages(t *testing.T) {
	cases := map[string]struct {
		source string
		want   []string
	}{
		"src/net.c":         {"struct point { int x; };\nstatic int add(int a, int b) { return a + b; }\nint main(void) { return add(1, 2); }\n", []string{"point", "add", "main"}},
		"src/Invoice.kt":    {"class Invoice(val t: Int) { fun late(d: Int): Int { return t } }\nobject Registry { fun get() = 1 }\nfun top() {}\n", []string{"Invoice", "late", "Registry", "get", "top"}},
		"src/Invoice.swift": {"struct Invoice { func total() -> Int { return 1 } }\nprotocol Store { func load() }\nfunc top() {}\n", []string{"Invoice", "total", "Store", "load", "top"}},
		"src/Invoice.php":   {"<?php\nclass Invoice { public function total(): int { return 1; } }\ninterface Payer { public function pay(); }\ntrait Audits {}\nfunction top() {}\n", []string{"Invoice", "total", "Payer", "pay", "Audits", "top"}},
	}
	for name, c := range cases {
		r := parseSource(t, name, c.source)
		got := map[string]bool{}
		for _, s := range r.Symbols {
			got[s.Name] = true
		}
		for _, w := range c.want {
			if !got[w] {
				t.Errorf("%s: missing symbol %q in %+v", name, w, r.Symbols)
			}
		}
	}
}
