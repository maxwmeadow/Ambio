import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))
const PYTHON = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version'], { timeout: 10_000 }).status === 0)

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
    watched: symbol => doc.watched.find(w => w.symbol === symbol),
    fn: symbol => doc.functions.find(f => f.name === symbol),
  }
}

const outcomes = w => w.samples.map(s => s.threw ? `threw ${s.threw}` : s.returned)

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
