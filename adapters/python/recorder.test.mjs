import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))
// PYTHON_BINARY picks the interpreter, to run these against a particular version.
const PYTHON = [process.env.PYTHON_BINARY, 'python3', 'python'].filter(Boolean).find(cmd => spawnSync(cmd, ['--version'], { timeout: 10_000 }).status === 0)

/** Run `code` as a workspace file under the recorder; return the evidence. */
function record(code, watches) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-pyrec-')))
  const evidence = join(root, '.evidence')
  const file = join(root, 'app.py')
  writeFileSync(file, code)
  const result = spawnSync(PYTHON, [file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PYTHONPATH: ADAPTER,
      AXIOM_WORKSPACE_ROOT: root,
      AXIOM_EVIDENCE_DIR: evidence,
      AXIOM_WATCHES: JSON.stringify(watches.map(w => ({ absPath: file, symbol: w }))),
    },
  })
  const docs = readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
  assert.equal(docs.length, 1, `expected one evidence file; stderr:\n${result.stderr}`)
  const doc = docs[0]
  return {
    doc,
    watched: symbol => doc.watched.find(w => w.symbol === symbol),
    fn: symbol => doc.functions.find(f => f.name === symbol),
  }
}

const outcomes = w => w.samples.map(s => s.threw ? `threw ${s.threw}` : s.returned)

test('a Python run records arguments, mutations, shared state, drift and the crash', { skip: !PYTHON && 'no Python' }, () => {
  const r = record(`
class Customer:
    def __init__(self, cid):
        self.cid = cid
        self.discount = 10

CACHE = {}

def find(cid):
    if cid not in CACHE:
        CACHE[cid] = Customer(cid)
    return CACHE[cid]

def apply_peak(table):
    table["peak"] = table.get("peak", 0) + 2.5
    return table["peak"]

def ship(qty):
    if qty > 5:
        raise ValueError("cannot ship %d" % qty)
    return qty

TABLE = {}
for _ in range(3):
    apply_peak(TABLE)
find("a")
find("a").discount += 5
find("a")
ship(2)
ship(9)
`, ['apply_peak', 'find', 'ship'])
  const peak = r.watched('apply_peak')
  assert.equal(peak.calls, 3)
  assert.deepEqual(peak.samples.map(s => `${s.args} -> ${s.returned}`), ['{"table": {}} -> 2.5', '{"table": {"peak": 2.5}} -> 5.0', '{"table": {"peak": 5.0}} -> 7.5'])
  assert.deepEqual(peak.mutations.find(m => m.path === 'table.peak').examples.map(e => `${e.before}>${e.after}`), ['(absent)>2.5', '2.5>5.0', '5.0>7.5'])
  assert.deepEqual(peak.shared, [{ param: 'table', calls: 2, firstCall: 1 }])
  // A cached object someone else changed shows up in what the cache returns.
  const drift = r.watched('find').drift.find(d => d.path === 'return')
  assert.ok(drift, JSON.stringify(r.watched('find').drift))
  assert.deepEqual(drift.examples[0].changes, [{ key: 'discount', before: '10', after: '15' }])
  const ship = r.watched('ship')
  assert.deepEqual(ship.samples.map(s => s.threw ?? s.returned), ['2', 'ValueError: cannot ship 9'])
  assert.equal(ship.errors, 1)
})

test('a function that handles an exception and returns None did not raise', { skip: !PYTHON && 'no Python' }, () => {
  const r = record(`
def lookup(d, k):
    try:
        return d[k]
    except KeyError:
        pass
def fail(x):
    raise ValueError("bad %s" % x)
def tidy(x):
    try:
        fail(x)
    finally:
        done = True
lookup({}, "a"); lookup({"a": 1}, "a")
for f in (fail, tidy):
    try: f(1)
    except ValueError: pass
`, ['lookup', 'tidy'])
  assert.deepEqual(outcomes(r.watched('lookup')), ['None', '1'])
  assert.equal(r.fn('lookup').errors, 0)
  assert.deepEqual(outcomes(r.watched('tidy')), ['threw ValueError: bad 1'], 'a finally block re-raises')
  assert.equal(r.fn('fail').errors, 2) // once directly, once under tidy
})

test('a generator or coroutine is one call however often it resumes', { skip: !PYTHON && 'no Python' }, () => {
  const r = record(`
import asyncio
def counter(n):
    for i in range(n):
        yield i * 10
def relay(n):
    yield from counter(n)
async def fetch(v):
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    return v + 1
list(counter(5)); list(relay(2))
g = counter(9); next(g); g.close()
g = counter(3); next(g)
try: g.throw(KeyError("thrown"))
except KeyError: pass
asyncio.run(fetch(41))
`, ['counter', 'relay', 'fetch'])
  assert.deepEqual(outcomes(r.watched('counter')), [
    'yielded 5 values: 0, 10, 20, …',
    'yielded 2 values: 0, 10',
    'yielded 1 value: 0', // closed early: finished, not failed
    "threw KeyError: 'thrown'",
  ])
  assert.equal(r.fn('counter').calls, 4)
  assert.deepEqual(outcomes(r.watched('relay')), ['yielded 2 values: 0, 10'])
  assert.deepEqual(outcomes(r.watched('fetch')), ['42'])
  assert.equal(r.fn('fetch').calls, 1)
})
