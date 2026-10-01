import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness, harnessFetch } from './mcpHarness.mjs'

/**
 * The experiment loop, end to end through the real MCP server, archd and the
 * runtime adapters: an agent states a hypothesis, runs a repro under
 * observation, gets evidence back, is interrupted by the human, and closes the
 * case - and the timeline the canvas replays holds every step.
 *
 * The fixture has bugs of the kinds runs exist to catch: a function that
 * writes into an object it is handed again on every call (JavaScript, and
 * Ruby), and a crash (Python, and Ruby).
 */

const PYTHON = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0)
const RUBY = spawnSync('ruby', ['--version']).status === 0
const GO = spawnSync('go', ['version']).status === 0
// A JDK from JAVA_HOME or the PATH; the commands below name it in full, so
// the run does not depend on what archd's own PATH holds.
const jdkTool = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name) : name
const JDK = spawnSync(jdkTool('javac'), ['-version']).status === 0
// Cargo, by its full path (CARGO, or wherever the PATH finds it).
const cargoProbe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cargo'], { encoding: 'utf8' })
const cargo = process.env.CARGO || (cargoProbe.status === 0 ? cargoProbe.stdout.split('\n')[0].trim() : '')
const CARGO = cargo !== '' && spawnSync(cargo, ['--version']).status === 0
const phpBinary = process.env.PHP_BINARY || 'php'
const PHP = spawnSync(phpBinary, ['-r', 'exit(PHP_VERSION_ID >= 70100 ? 0 : 1);']).status === 0
// The .NET SDK from DOTNET_ROOT or the PATH, named in full for the same reason.
const dotnet = process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet') : 'dotnet'
const dotnetProbe = spawnSync(dotnet, ['--version'], { encoding: 'utf8' })
const DOTNET = dotnetProbe.status === 0 ? Number(dotnetProbe.stdout.split('.')[0]) : 0

let harness
let client
let project

async function api(path, init) {
  const res = await harnessFetch(`${harness.apiBase}${path}`, init)
  return res.json()
}

test.before(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-run-e2e-')))
  mkdirSync(join(project, 'billing'))
  writeFileSync(join(project, 'billing', 'ledger.js'), [
    "'use strict'",
    'const DEFAULT_FEES = { fees: {} }',
    '',
    'function applyLateFee(table, amount) {',
    '  table.fees.late = (table.fees.late || 0) + amount',
    '  return table',
    '}',
    '',
    'function invoiceTotal(base) {',
    '  return base + applyLateFee(DEFAULT_FEES, 5).fees.late',
    '}',
    '',
    'module.exports = { applyLateFee, invoiceTotal }',
  ].join('\n'))
  mkdirSync(join(project, 'shop'), { recursive: true })
  writeFileSync(join(project, 'shop', 'Stock.java'), [
    'package shop;',
    '',
    'import java.util.HashMap;',
    'import java.util.Map;',
    '',
    'public class Stock {',
    '    static final Map<String, Integer> LEVELS = new HashMap<>();',
    '',
    '    static int reserve(Map<String, Integer> stock, String item, int qty) {',
    '        int have = stock.getOrDefault(item, 0);',
    '        if (qty > have) {',
    '            throw new IllegalArgumentException("not enough " + item);',
    '        }',
    '        stock.put(item, have - qty);',
    '        return have - qty;',
    '    }',
    '',
    '    public static void main(String[] args) {',
    '        LEVELS.put("widget", 10);',
    '        for (int i = 0; i < 4; i++) {',
    '            reserve(LEVELS, "widget", 3);',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n'))
  mkdirSync(join(project, 'depot', 'src'), { recursive: true })
  writeFileSync(join(project, 'depot', 'Cargo.toml'), '[package]\nname = "depot"\nversion = "0.1.0"\nedition = "2021"\n')
  writeFileSync(join(project, 'depot', 'src', 'main.rs'), [
    'use std::collections::BTreeMap;',
    '',
    '#[derive(Debug)]',
    'struct Depot {',
    '    levels: BTreeMap<String, i64>,',
    '}',
    '',
    'fn reserve(depot: &mut Depot, item: &str, qty: i64) -> Result<i64, String> {',
    '    let have = *depot.levels.get(item).unwrap_or(&0);',
    '    if qty > have {',
    '        return Err(format!("not enough {item}"));',
    '    }',
    '    depot.levels.insert(item.to_string(), have - qty);',
    '    Ok(have - qty)',
    '}',
    '',
    'fn main() {',
    '    let mut depot = Box::new(Depot { levels: BTreeMap::from([("widget".to_string(), 10)]) });',
    '    for _ in 0..3 {',
    '        reserve(&mut depot, "widget", 3).unwrap();',
    '    }',
    '    reserve(&mut depot, "widget", 3).unwrap();',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(project, 'cart.php'), [
    '<?php',
    'final class Cart { public $total = 0; public $lines = []; }',
    '',
    'function addLine(Cart $cart, string $item, int $price): int',
    '{',
    '    if ($price < 0) {',
    "        throw new InvalidArgumentException('negative price');",
    '    }',
    '    $cart->lines[] = $item;',
    '    $cart->total += $price;',
    '    return $cart->total;',
    '}',
    '',
    '$cart = new Cart();',
    "addLine($cart, 'tea', 4);",
    "addLine($cart, 'jam', 6);",
    "echo $cart->total, PHP_EOL;",
    "addLine($cart, 'refund', -1);",
    '',
  ].join('\n'))
  mkdirSync(join(project, 'ledger'), { recursive: true })
  writeFileSync(join(project, 'ledger', 'Ledger.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    `    <TargetFramework>net${DOTNET || 8}.0</TargetFramework>`,
    '    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>',
    '  </PropertyGroup>',
    '</Project>',
    '',
  ].join('\n'))
  writeFileSync(join(project, 'ledger', 'Ledger.cs'), [
    'using System;',
    'using System.Collections.Generic;',
    '',
    'public class Customer { public string Id = ""; public int Discount; }',
    '',
    'public static class Ledger',
    '{',
    '    static readonly Dictionary<string, Customer> Cache = new Dictionary<string, Customer>();',
    '',
    '    static Customer Find(string id)',
    '    {',
    '        if (!Cache.TryGetValue(id, out var c)) Cache[id] = c = new Customer { Id = id, Discount = 10 };',
    '        return c;',
    '    }',
    '',
    '    static int Total(string id, int amount)',
    '    {',
    '        if (amount < 0) throw new ArgumentException("negative amount");',
    '        return amount - Find(id).Discount;',
    '    }',
    '',
    '    public static void Main()',
    '    {',
    '        Console.WriteLine(Total("a", 100));',
    '        Find("a").Discount += 5;',
    '        Console.WriteLine(Total("a", 100));',
    '        Total("a", -1);',
    '    }',
    '}',
    '',
  ].join('\n'))
  // A server whose handler adds to a shared table on every request.
  writeFileSync(join(project, 'billing', 'server.js'), [
    "const http = require('node:http')",
    'const RATES = { base: 10 }',
    'function quote(rates) {',
    '  rates.base += 5',
    '  return rates.base',
    '}',
    "http.createServer((req, res) => res.end(String(quote(RATES)))).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('quotes ready'))",
    '',
  ].join('\n'))
  writeFileSync(join(project, 'billing', 'repro.js'),
    "const { invoiceTotal } = require('./ledger')\nfor (const base of [100, 100, 100, 100]) console.log(invoiceTotal(base))\n")
  writeFileSync(join(project, 'stock.py'), [
    'def ship(on_hand, qty):',
    '    if qty > on_hand:',
    '        raise ValueError("cannot ship %d" % qty)',
    '    return on_hand - qty',
    '',
    'print(ship(5, 1))',
    'print(ship(5, 9))',
  ].join('\n'))
  writeFileSync(join(project, 'inventory.rb'), [
    'DEFAULT_STOCK = { "widget" => 10 }',
    '',
    'class Warehouse',
    '  def reserve(stock, sku, qty)',
    '    raise ArgumentError, "not enough #{sku}" if stock[sku] < qty',
    '    stock[sku] -= qty',
    '    stock',
    '  end',
    'end',
    '',
    'w = Warehouse.new',
    '4.times { puts w.reserve(DEFAULT_STOCK, "widget", 3)["widget"] }',
  ].join('\n'))
  writeFileSync(join(project, 'go.mod'), 'module example.com/stock\n\ngo 1.21\n')
  writeFileSync(join(project, 'reserve.go'), [
    'package main',
    '',
    'import (',
    '\t"errors"',
    '\t"fmt"',
    ')',
    '',
    'var defaultStock = map[string]int{"widget": 10}',
    '',
    'func reserve(stock map[string]int, sku string, qty int) (int, error) {',
    '\tif stock[sku] < qty {',
    '\t\treturn 0, errors.New("not enough " + sku)',
    '\t}',
    '\tstock[sku] -= qty',
    '\treturn stock[sku], nil',
    '}',
    '',
    'func main() {',
    '\tfor i := 0; i < 4; i++ {',
    '\t\tleft, err := reserve(defaultStock, "widget", 3)',
    '\t\tfmt.Println(left, err)',
    '\t}',
    '\tvar orders []string',
    '\tfmt.Println(orders[2])',
    '}',
  ].join('\n'))
  writeFileSync(join(project, 'ledger.rb'), [
    'Customer = Struct.new(:name, :discount)',
    'CACHE = {}',
    '',
    'def lookup(id)',
    '  CACHE[id] ||= Customer.new(id, 0)',
    'end',
    '',
    'def price(customer, base)',
    '  base - customer.discount',
    'end',
    '',
    'puts price(lookup("a"), 100)',
    'lookup("a").discount = 30',
    'puts price(lookup("a"), 100)',
  ].join('\n'))
  harness = await startHarness({ projectDir: project, minFiles: 6 })
  client = harness.client
}, { timeout: 90000 })

test.after(() => {
  harness?.stop()
  if (project) rmSync(project, { recursive: true, force: true })
})

test('a run reports the side effect reading the code would have to infer', async () => {
  const started = await client.callTool('investigation', { op: 'start', name: 'Invoices creep up' })
  assert.match(started.text, /Runs record calls, arguments and returns for [^.]*JavaScript\/TypeScript \(3 files\)/,
    'the agent learns what a run can see before planning one')
  const h = await client.callTool('investigation', { op: 'hypothesis', text: 'applyLateFee() accumulates into the shared DEFAULT_FEES table' })
  assert.equal(h.isError, false, h.text)
  assert.match(h.text, /H1 recorded on billing\/ledger\.js › applyLateFee/, 'the hypothesis is anchored from its text')

  const run = await client.callTool('investigation', {
    op: 'run', command: 'node billing/repro.js', watch: ['billing/ledger.js:applyLateFee'], hypothesis: 'H1',
  }, 60000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /^Run R1 · `node billing\/repro\.js` · exit 0/)
  assert.match(run.text, /`applyLateFee` changes its argument `table\.fees\.late` on all 4 calls: \(absent\) → 5, 5 → 10/)
  assert.match(run.text, /receives the same `table` object again on 3 of 4 calls/)
  assert.match(run.text, /Record what this showed: investigation verdict/)
  assert.match(run.text, /\n105\n110\n115\n120/, 'the program output is included')
})

test('the human watching reaches the agent on its next step, exactly once', async () => {
  const sent = await api('/api/investigation/message', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: harness.workspaceId, text: 'Is invoiceTotal the only caller?' }),
  })
  assert.ok(sent.message?.id)

  const verdict = await client.callTool('investigation', { op: 'verdict', hypothesis: 'H1', result: 'confirmed', run: 'R1' })
  assert.equal(verdict.isError, false, verdict.text)
  assert.match(verdict.text, /H1 marked confirmed/)
  assert.match(verdict.text, /The person watching your investigation says:\n> Is invoiceTotal the only caller\?/)

  const next = await client.callTool('investigation', { op: 'note', text: 'invoiceTotal() is the only caller of applyLateFee' })
  assert.doesNotMatch(next.text, /The person watching/, 'a message is delivered once')
  assert.match(next.text, /Noted on billing\/ledger\.js › invoiceTotal/)

  const c = await api(`/api/investigation/case?workspace=${harness.workspaceId}`)
  assert.ok(c.case.messages[0].deliveredAt, 'the canvas can show the message was delivered')
})

test('a crash is pinned to the line in the user\'s code', { skip: !PYTHON && 'no python on this machine' }, async () => {
  const run = await client.callTool('investigation', { op: 'run', command: `${PYTHON} stock.py`, watch: ['stock.py:ship'] }, 60000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /Uncaught `ValueError: cannot ship 9` at stock\.py:3/)
  assert.match(run.text, /`ship` threw `ValueError: cannot ship 9` on 1 of 2 calls/)
})

// Ruby records through TracePoint loaded by RUBYOPT: nothing to install, no
// debugger, the same evidence as the other recorders.
test('a Ruby run shows the shared state and the crash, with nothing installed', { skip: !RUBY && 'no ruby on this machine' }, async () => {
  const run = await client.callTool('investigation', { op: 'run', command: 'ruby inventory.rb', watch: ['inventory.rb:reserve'] }, 60000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`reserve` changes its argument `stock\.widget` on 3 of 4 calls: 10 → 7, 7 → 4/)
  assert.match(run.text, /receives the same `stock` object again on 3 of 4 calls/)
  assert.match(run.text, /Uncaught `ArgumentError: not enough widget` at inventory\.rb:5/)
})

// Go records through a build overlay the go command applies: the module's
// files are rewritten for the run only, nothing on disk changes.
test('a Go run shows the shared map, the returned error and the panic', { skip: !GO && 'no go on this machine' }, async () => {
  const run = await client.callTool('investigation', { op: 'run', command: 'go run .', watch: ['reserve.go:reserve'] }, 120000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`reserve` changes its argument `stock\.widget` on 3 of 4 calls: 10 → 7, 7 → 4/)
  assert.match(run.text, /receives the same `stock` object again on 3 of 4 calls/)
  assert.match(run.text, /`reserve` returned `error: not enough widget` on 1 of 4 calls/)
  assert.match(run.text, /Uncaught `panic: runtime error: index out of range \[2\] with length 0` at reserve\.go:24/)
})

test('a Ruby run sees a cached object change between calls', { skip: !RUBY && 'no ruby on this machine' }, async () => {
  const run = await client.callTool('investigation', { op: 'run', command: 'ruby ledger.rb', watch: ['ledger.rb:price'] }, 60000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`customer` is the same object on calls 1 and 2 of `price`, and it changed in between: `discount` 0 → 30/)
})

// The JVM records through an agent every JVM loads from JAVA_TOOL_OPTIONS:
// the same evidence, with nothing installed beyond the user's own JDK.
test('a Java run shows the shared map, the thrown exception and the crash', { skip: !JDK && 'no JDK on this machine' }, async () => {
  const command = `"${jdkTool('javac')}" -g -d out/classes shop/Stock.java && "${jdkTool('java')}" -cp out/classes shop.Stock`
  const run = await client.callTool('investigation', { op: 'run', command, watch: ['shop/Stock.java:reserve'] }, 120000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`reserve` changes its argument `stock\.widget` on 3 of 4 calls: 10 → 7, 7 → 4/)
  assert.match(run.text, /receives the same `stock` object again on 3 of 4 calls/)
  assert.match(run.text, /`reserve` threw `IllegalArgumentException: not enough widget` on 1 of 4 calls/)
  assert.match(run.text, /Uncaught `IllegalArgumentException: not enough widget` at shop\/Stock\.java:12/)
  assert.doesNotMatch(run.text, /Picked up JAVA_TOOL_OPTIONS/, 'the JVM notice about the agent is not the program\'s output')
})

// Rust records through Cargo: archd is the compiler wrapper for the workspace's
// crates and compiles instrumented copies of their sources.
test('a Rust run shows the mutated state, the returned error and the panic', { skip: !CARGO && 'no Rust toolchain on this machine' }, async () => {
  const run = await client.callTool('investigation', {
    op: 'run', command: `"${cargo}" run -q --manifest-path depot/Cargo.toml`, watch: ['depot/src/main.rs:reserve'], timeoutSec: 300,
  }, 330000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`reserve` changes its argument `depot\.levels\.widget` on 3 of 4 calls: 10 → 7, 7 → 4/)
  assert.match(run.text, /receives the same `depot` object again on 3 of 4 calls/)
  assert.match(run.text, /`reserve` returned `error: "not enough widget"` on 1 of 4 calls/)
  assert.match(run.text, /Uncaught `panic: called `Result::unwrap\(\)` on an `Err` value: "not enough widget"` at depot\/src\/main\.rs:22/)
  // The program's own panic message names its own file and line.
  assert.match(run.text, /panicked at src\/main\.rs:22:38/)
})

// PHP records through its own configuration: an ini file prepends the recorder
// to every script, and it rewrites the program's files as PHP includes them.
test('a PHP run shows the mutated object, the exception and the crash', { skip: !PHP && 'no PHP on this machine' }, async () => {
  const run = await client.callTool('investigation', { op: 'run', command: `"${phpBinary}" cart.php`, watch: ['cart.php:addLine'] }, 60000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`addLine` changes its argument `cart\.total` on 2 of 3 calls: 0 → 4, 4 → 10/)
  assert.match(run.text, /receives the same `cart` object again on 2 of 3 calls/)
  assert.match(run.text, /Uncaught `InvalidArgumentException: negative price` at cart\.php:7/)
  assert.match(run.text, /\n10\n/)
})

// C# records through the build: MSBuild compiles instrumented copies of the
// project's sources, with the user's own SDK and nothing else installed.
test('a C# run shows the cached object that changed, the exception and the crash', { skip: DOTNET < 6 && 'no .NET SDK on this machine' }, async () => {
  const run = await client.callTool('investigation', {
    op: 'run', command: `"${dotnet}" run --project ledger`, watch: ['ledger/Ledger.cs:Find', 'ledger/Ledger.cs:Total'], timeoutSec: 300,
  }, 330000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /`Find` returns the same object on calls 2 and 3, and it changed in between: `Discount` 10 → 15/)
  assert.match(run.text, /call 2: \{"id": "a", "amount": 100\} → 85/)
  assert.match(run.text, /Uncaught `ArgumentException: negative amount` at ledger\/Ledger\.cs:18/)
  assert.match(run.text, /\n90\n85\n/)
})

// A bug behind a server: the server runs under the recorder, the command is
// the request, and the report covers both.
test('a run against a server records what the server did with the request', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const hit = `node -e "(async () => { for (let i = 0; i < 3; i++) console.log(await (await fetch('http://127.0.0.1:${port}/')).text()) })()"`
  const run = await client.callTool('investigation', {
    op: 'run', server: `node billing/server.js ${port}`, port, command: hit, watch: ['billing/server.js:quote'],
  }, 60000)
  assert.equal(run.isError, false, run.text)
  assert.match(run.text, /against `node billing\/server\.js \d+`/)
  assert.match(run.text, /`quote` changes its argument `rates\.base` on all 3 calls: 10 → 15, 15 → 20/)
  assert.match(run.text, /Server output \(stopped after the command, ready after [^)]+\)\nquotes ready/)
  assert.match(run.text, /\nOutput\n15\n20\n25\n/)

  const dead = await client.callTool('investigation', {
    op: 'run', server: 'node billing/no-such-server.js', port: port + 1, command: 'echo unreachable',
  }, 60000)
  assert.equal(dead.isError, false, dead.text)
  assert.match(dead.text, /not run/)
  assert.match(dead.text, /The command did not run: the server exited with code 1 before it was ready/)
  assert.doesNotMatch(dead.text, /\nunreachable/)
})

test('a watch that names nothing fails before running, with the reason', async () => {
  const bad = await client.callTool('investigation', { op: 'run', command: 'node billing/repro.js', watch: ['noSuchFunction'] })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /no function named \\"noSuchFunction\\"/)
  const escape = await client.callTool('investigation', { op: 'run', command: 'ls', cwd: '../..' })
  assert.equal(escape.isError, true)
  assert.match(escape.text, /outside the workspace/)
})

test('closing the case leaves a timeline the canvas can replay step by step', async () => {
  const concluded = await client.callTool('investigation', {
    op: 'conclude', text: 'applyLateFee writes into DEFAULT_FEES, which every invoice shares', fix: 'copy the table per invoice',
  })
  assert.equal(concluded.isError, false, concluded.text)
  const c = await api(`/api/investigation/case?workspace=${harness.workspaceId}`)
  const id = c.case.id
  assert.equal(c.case.hypotheses[0].status, 'confirmed')
  assert.ok(c.case.runs.length >= 1)

  const stopped = await client.callTool('investigation', { op: 'stop' })
  assert.equal(stopped.isError, false, stopped.text)
  const doc = await api(`/api/investigation/${id}?workspace=${harness.workspaceId}`)
  const types = new Set(doc.events.map(e => e.type))
  for (const t of ['investigation:hypothesis', 'investigation:run_started', 'investigation:run', 'investigation:verdict',
    'investigation:message', 'investigation:message_delivered', 'investigation:note', 'investigation:conclusion']) {
    assert.ok(types.has(t), `${t} missing from the timeline: ${[...types].join(', ')}`)
  }
  assert.equal(doc.conclusion.rootCause, 'applyLateFee writes into DEFAULT_FEES, which every invoice shares')
  const run = doc.events.find(e => e.type === 'investigation:run').payload.run
  assert.ok(run.watched.length === 1 && run.findings.length > 0, 'the run event carries its evidence for replay')
})
