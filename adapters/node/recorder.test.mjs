import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))

/** Run `code` as a workspace file under the recorder; return the merged evidence. */
function record(code, watches, name = 'app.js') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ambio-rec-')))
  const evidence = join(root, '.evidence')
  const file = join(root, name)
  writeFileSync(file, code)
  const result = spawnSync(process.execPath, [file], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${JSON.stringify(join(ADAPTER, 'cjs-bootstrap.cjs'))} --import ${JSON.stringify(pathToFileURL(join(ADAPTER, 'esm-bootstrap.mjs')).href)}`,
      AMBIO_RUNTIME_PORT: '1', // nothing listens: the recorder must not care
      AMBIO_WORKSPACE_ROOT: root,
      AMBIO_EVIDENCE_DIR: evidence,
      AMBIO_WATCHES: JSON.stringify(watches.map(w => ({ absPath: file, symbol: w }))),
    },
  })
  const docs = readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
  assert.equal(docs.length, 1, `expected one evidence file; stderr:\n${result.stderr}`)
  const doc = docs[0]
  return {
    doc,
    status: result.status,
    stdout: result.stdout,
    watched: symbol => doc.watched.find(w => w.symbol === symbol),
    fn: symbol => doc.functions.find(f => f.name === symbol),
  }
}

test('a mutated argument that comes back on the next call is caught', () => {
  const r = record(`
    const TABLE = { surcharges: {} }
    function applyPeak(table) { table.surcharges.peak = (table.surcharges.peak || 0) + 2.5 }
    for (let i = 0; i < 5; i++) applyPeak(TABLE)
  `, ['applyPeak'])
  const w = r.watched('applyPeak')
  assert.equal(w.calls, 5)
  const m = w.mutations.find(x => x.path === 'table.surcharges.peak')
  assert.ok(m, `mutations: ${JSON.stringify(w.mutations)}`)
  assert.equal(m.calls, 5)
  assert.deepEqual(m.examples.slice(0, 2).map(e => `${e.before}>${e.after}`), ['(absent)>2.5', '2.5>5'])
  assert.deepEqual(w.shared.map(s => [s.param, s.calls]), [['table', 4]])
  assert.equal(w.mutations.some(x => x.path === 'table.surcharges'), false, 'an empty object gaining a key is one change, not two')
})

test('the same arguments twice in a row count as a repeat', () => {
  const r = record(`
    function award(receipt) { return receipt.total }
    for (const receipt of [{ total: 1 }, { total: 2 }]) { award(receipt); award(receipt) }
  `, ['award'])
  const w = r.watched('award')
  assert.equal(w.calls, 4)
  assert.equal(w.repeats, 2)
  assert.equal(w.repeatExample.call, 2)
})

test('exceptions, fall-through returns and the program exit code are all kept', () => {
  const r = record(`
    function ship(qty) { if (qty > 5) throw new RangeError('too many'); }
    ship(1)
    try { ship(9) } catch {}
    ship(10)
  `, ['ship'])
  const w = r.watched('ship')
  assert.equal(w.calls, 3)
  assert.equal(w.errors, 2)
  assert.deepEqual(w.exceptions, [{ what: 'RangeError: too many', n: 2 }])
  assert.equal(w.samples[0].returned, 'undefined', 'a function without a return statement returns undefined')
  assert.notEqual(r.status, 0)
  assert.match(r.doc.uncaught[0].what, /RangeError: too many/)
})

test('a hot function is sampled, but its counts stay exact', () => {
  const r = record(`
    function hot(n) { return n % 7 }
    let t = 0
    for (let i = 0; i < 20000; i++) t += hot(i)
    console.log(t)
  `, ['hot'])
  const w = r.watched('hot')
  assert.equal(w.calls, 20000)
  assert.ok(w.sampled >= 100 && w.sampled < 2000, `sampled ${w.sampled}`)
  assert.equal(r.fn('hot').calls, 20000)
})

test('who called whom is recorded for every function, watched or not', () => {
  const r = record(`
    function leaf() { return 1 }
    function mid() { return leaf() + leaf() }
    function top() { return mid() }
    top()
  `, [])
  const edge = r.doc.edges.find(e => e.from.name === 'mid' && e.to.name === 'leaf')
  assert.ok(edge, JSON.stringify(r.doc.edges))
  assert.equal(edge.calls, 2)
  assert.equal(r.doc.watched.length, 0)
})

test('a method sees its receiver; changing its own state is recorded as such', () => {
  const r = record(`
    class Counter { constructor() { this.n = 0 } bump(by) { this.n += by; return this.n } }
    const c = new Counter()
    c.bump(1); c.bump(2)
  `, ['bump', 'constructor'])
  const bump = r.watched('bump')
  assert.ok(bump.mutations.some(m => m.path === 'this.n'), JSON.stringify(bump.mutations))
  assert.equal(bump.shared.length, 0, 'the receiver is not an argument shared between calls')
  assert.equal(r.watched('constructor').calls, 1, 'constructors are observed')
})

test('TypeScript files run and record under their own line numbers', () => {
  const r = record(`
export function double(x: number): number {
  return x * 2
}
console.log(double(21))
`, ['double'], 'lib.ts')
  assert.equal(r.stdout.trim(), '42')
  const w = r.watched('double')
  assert.equal(w.calls, 1)
  assert.equal(w.line, 2)
  assert.equal(w.samples[0].returned, '42')
})

test('shared state that changes between calls is caught even when no argument is mutated', () => {
  // The marked bug in miniature: a module-level rule table, reached through
  // a fresh per-call options object, is changed by one call and seen changed
  // by the next. No call mutates an argument it was handed.
  const r = record(`
    const RULES = { gfm: { br: 'two-spaces', text: 'plain' }, breaks: { br: 'any', text: 'soft' } }
    function lex(src, options) {
      const opts = { ...options }
      opts.rules = options.breaks ? Object.assign(RULES.gfm, RULES.breaks) : RULES.gfm
      return render(src, opts)
    }
    function render(src, opts) { return src + ':' + opts.rules.br }
    console.log(render('docs', { rules: RULES.gfm }))
    render('comment', { rules: lex('comment', { breaks: true }) && RULES.gfm })
    console.log(render('docs', { rules: RULES.gfm }))
  `, ['render'])
  const w = r.watched('render')
  const d = w.drift.find(x => x.path === 'opts.rules')
  assert.ok(d, `drift: ${JSON.stringify(w.drift)}`)
  assert.deepEqual(d.examples[0].changes.find(c => c.key === 'br'), { key: 'br', before: '"two-spaces"', after: '"any"' })
})

test('a cached object someone else changed shows up as drift in what the cache returns', () => {
  const r = record(`
    const cache = new Map()
    function getCustomer(id) {
      if (!cache.has(id)) cache.set(id, { id, discountRate: 0 })
      return cache.get(id)
    }
    function applyReferral(c) { Object.assign(c, { discountRate: 0.15 }) }
    getCustomer('a')
    applyReferral(getCustomer('a'))
    console.log(getCustomer('a').discountRate)
  `, ['getCustomer'])
  const d = r.watched('getCustomer').drift.find(x => x.path === 'return')
  assert.ok(d, JSON.stringify(r.watched('getCustomer').drift))
  assert.deepEqual(d.examples[0].changes, [{ key: 'discountRate', before: '0', after: '0.15' }])
})
