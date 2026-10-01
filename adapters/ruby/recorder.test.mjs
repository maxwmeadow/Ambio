import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = dirname(fileURLToPath(import.meta.url))
const version = spawnSync('ruby', ['-e', 'print RUBY_VERSION'], { encoding: 'utf8', timeout: 10_000 })
const RUBY = version.status === 0 ? version.stdout : ''
const [major, minor] = RUBY.split('.').map(Number)
const RESCUE_EVENT = major > 3 || (major === 3 && minor >= 3)

/** Run `code` as a workspace file under the recorder; return the evidence. */
function record(code, watches = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-rbrec-')))
  const evidence = join(root, '.evidence')
  const file = join(root, 'app.rb')
  writeFileSync(file, code)
  const result = spawnSync('ruby', [file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      RUBYLIB: ADAPTER,
      RUBYOPT: '-raxiom_recorder',
      AXIOM_WORKSPACE_ROOT: root,
      AXIOM_EVIDENCE_DIR: evidence,
      AXIOM_WATCHES: JSON.stringify(watches.map(w => ({ absPath: file, symbol: w }))),
    },
  })
  const docs = readdirSync(evidence).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(evidence, f), 'utf8')))
  assert.equal(docs.length, 1, `expected one evidence file; stderr:\n${result.stderr}`)
  const doc = docs[0]
  return { errors: name => doc.functions.find(f => f.name === name)?.errors }
}

test('an exception counts against every method it unwinds, and only those', { skip: !RUBY && 'no Ruby' }, () => {
  const r = record(`
def ok; nil; end
def fail; raise ArgumentError, "a"; end
def through; fail; end
def outer; through; end
def handled_then_logs; fail; rescue ArgumentError; ok; nil; end
def handled_quietly; fail; rescue ArgumentError; nil; end
def tidy; fail; ensure; x = 1; end
def iterate; e = [1].each; loop { e.next }; nil; end
[:outer, :tidy].each { |m| begin; send(m); rescue => e; end }
handled_then_logs; handled_quietly; iterate; ok
`)
  assert.equal(r.errors('fail'), 4)
  assert.equal(r.errors('through'), 1, 'raised in a callee and not rescued')
  assert.equal(r.errors('outer'), 1)
  assert.equal(r.errors('tidy'), 1, 'an ensure clause does not swallow it')
  assert.equal(r.errors('handled_then_logs'), 0)
  assert.equal(r.errors('iterate'), 0, 'StopIteration ending a loop is control flow')
  assert.equal(r.errors('ok'), 0)
  // Before Ruby 3.3 there is no :rescue event, and a method that rescues and
  // returns nil without calling anything cannot be told from one that raised.
  assert.equal(r.errors('handled_quietly'), RESCUE_EVENT ? 0 : 1)
})
