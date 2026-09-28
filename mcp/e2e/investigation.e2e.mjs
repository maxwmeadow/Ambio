import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness } from './mcpHarness.mjs'

/**
 * Proves the debugging loop an agent actually drives.
 *
 * Every piece of this was individually present and collectively unreachable:
 * `investigation` was advertised only behind AXIOM_MCP_PROFILE=debug, which
 * nothing set, so no agent could see the tool at all. These tests assert the
 * whole path - that it is advertised, that a session records, that work done
 * in between is captured without being asked for, and that stopping yields a
 * document the canvas can replay.
 */

let harness
let client

test.before(async () => {
  harness = await startHarness()
  client = harness.client
}, { timeout: 90000 })

test.after(() => harness?.stop())

test('an agent can see the recorder without opting into a profile', async () => {
  const response = await client.request('tools/list', {})
  const names = response.result.tools.map(tool => tool.name)
  assert.ok(names.includes('investigation'), 'investigation must be advertised by default')
  assert.equal(names.includes('debug_runtime'), false, 'value injection stays opt-in')
})

test('noting before starting says what to do instead of failing blankly', async () => {
  const result = await client.callTool('investigation', { op: 'note', text: 'too early' })
  assert.equal(result.isError, true)
  assert.match(result.text, /start/i, `unhelpful error: ${result.text}`)
})

test('a session records the work done inside it and replays as a document', async () => {
  const started = await client.callTool('investigation', { op: 'start', name: 'Checkout timeout' })
  assert.equal(started.isError, false, started.text)
  assert.match(started.text, /Checkout timeout/, 'the agent is told which case it opened')
  const open = await (await fetch(`${harness.apiBase}/api/investigation/case?workspace=${harness.workspaceId}`)).json()
  const id = open.case?.id
  assert.ok(id, 'a case is open')

  // Work an agent would do anyway. None of this asks to be recorded.
  const files = harness.snapshot.files ?? []
  const caller = files.find(file => file.relPath.endsWith('index.py')) ?? files[0]
  const traced = await client.callTool('trace_calls', { fileIds: [caller.id], direction: 'out', depth: 2 })
  assert.equal(traced.isError, false, traced.text)

  const noted = await client.callTool('investigation', { op: 'note', text: 'settle() returns unrounded cents' })
  assert.equal(noted.isError, false, noted.text)

  const stopped = await client.callTool('investigation', { op: 'stop' })
  assert.equal(stopped.isError, false, stopped.text)
  assert.match(stopped.text, new RegExp(`Case saved \\(${id}\\)`), stopped.text)

  const listed = await client.callTool('investigation', { op: 'list' })
  assert.equal(listed.isError, false, listed.text)
  const saved = (listed.payload?.investigations ?? []).find(item => item.id === id)
  assert.ok(saved, `the capture is missing from the list: ${listed.text}`)
  assert.equal(saved.status, 'saved', 'a stopped capture is saved, not left recording')

  // The agent reads a saved case as its case file, not a megabyte timeline.
  const read = await client.callTool('investigation', { op: 'get', id })
  assert.equal(read.isError, false, read.text)
  assert.match(read.text, /^Case: Checkout timeout/)

  // The canvas replays the document event by event, so the timeline has to
  // be intact where the canvas reads it.
  const doc = await (await fetch(`${harness.apiBase}/api/investigation/${id}?workspace=${harness.workspaceId}`)).json()
  const events = doc.events ?? []
  assert.ok(events.some(event => event.type === 'investigation:note'),
    `the agent's note should be on the timeline: ${events.map(e => e.type).join(', ')}`)
  // Work done inside a session is captured without being asked for: the
  // trace itself landed, which is what lets replay show the path.
  assert.ok(events.some(event => event.type === 'call:trace'),
    `the trace the agent ran should be on the timeline: ${events.map(e => e.type).join(', ')}`)
  assert.ok(events.every(event => typeof event.offsetMs === 'number'),
    'every event needs an offset for the replay transport to seek')
  assert.equal(events.filter(e => e.type === 'agent:activity' && /📝/.test(e.payload?.message ?? '')).length, 0,
    'a note is recorded once, not echoed as activity too')
})
