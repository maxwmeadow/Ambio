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
	if got := packages(py); !reflect.DeepEqual(got, []string{"boto3", "os", "psycopg2", "redis", "stripe"}) {
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
