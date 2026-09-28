import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness } from './mcpHarness.mjs'

/**
 * The experiment loop, end to end through the real MCP server, archd and the
 * runtime adapters: an agent states a hypothesis, runs a repro under
 * observation, gets evidence back, is interrupted by the human, and closes the
 * case - and the timeline the canvas replays holds every step.
 *
 * The fixture has bugs of the kinds runs exist to catch: a function that
 * writes into an object it is handed again on every call (JavaScript), and a
 * crash (Python).
 */

const PYTHON = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0)

let harness
let client
let project

async function api(path, init) {
  const res = await fetch(`${harness.apiBase}${path}`, init)
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
  harness = await startHarness({ projectDir: project, minFiles: 3 })
  client = harness.client
}, { timeout: 90000 })

test.after(() => {
  harness?.stop()
  if (project) rmSync(project, { recursive: true, force: true })
})

test('a run reports the side effect reading the code would have to infer', async () => {
  await client.callTool('investigation', { op: 'start', name: 'Invoices creep up' })
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
    op: 'conclude', rootCause: 'applyLateFee writes into DEFAULT_FEES, which every invoice shares', fix: 'copy the table per invoice',
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
