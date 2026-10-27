import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHarness, harnessFetch } from './mcpHarness.mjs'
import { DeliveryRunner } from '../../electron/agentDelivery.ts'

async function begin(h) {
  const messageId = `map-${Date.now()}`
  const post = (route, body) => harnessFetch(`${h.apiBase}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceId: h.workspaceId }) })
  assert.equal((await post('/api/canvas/send', { id: messageId, mode: 'propose', deliveryMode: 'addressed', note: 'This is a mapping request. Map only.' })).status, 200)
  const made = await post('/api/mapping-attempts', { messageId })
  assert.equal(made.status, 200, await made.clone().text())
  const binding = await made.json()
  const client = await h.createClient({ AMBIO_MAPPING_ATTEMPT: binding.attempt.id, AMBIO_API_TOKEN: binding.token, AMBIO_WORKSPACE_ID: h.workspaceId })
  return { binding, client, messageId }
}

test('mapping exposes only its task, submits once, and no tool can continue afterward', { timeout: 60000 }, async () => {
  const h = await startHarness()
  let client
  try {
    const started = await begin(h); client = started.client
    const surface = await client.request('tools/list', {})
    const names = surface.result.tools.map(tool => tool.name)
    assert.ok(names.includes('edit_systems'))
    for (const forbidden of ['start_work', 'reply_to_canvas', 'edit_sheet', 'investigation', 'edit_infra']) assert.ok(!names.includes(forbidden), forbidden)
    for (const [name, args] of [['start_work', { goal: 'Unrelated work' }], ['create_system', { name: 'Legacy bypass' }], ['edit_systems', { op: 'create', name: 'Live bypass' }], ['update_work', { done: true, summary: 'Done' }]]) {
      assert.equal((await client.callTool(name, args)).isError, true, name)
    }
    const draft = await client.callTool('edit_systems', { op: 'begin_session', rationale: 'Storage boundary' })
    assert.equal(draft.isError, false, draft.text)
    assert.equal(draft.payload.sessionId, started.binding.attempt.id)
    const read = await client.callTool('get_architecture', { scope: 'files' })
    assert.equal(read.isError, false, read.text)
    const search = await client.callTool('search_symbols', { query: 'record' })
    assert.equal(search.isError, false, search.text)
    assert.equal((await client.callTool('update_work', { note: 'Storage owns record persistence.' })).isError, false)
    // The Asymm run: files sent as filePaths were dropped, every system owned
    // nothing and commit failed with no way to correct the stored chunks.
    const misnamed = await client.callTool('edit_systems', { op: 'add_chunk', sessionId: draft.payload.sessionId, chunkId: 'one', systems: [{ systemKey: 'storage', name: 'Storage', filePaths: ['storage/record.py'] }] })
    assert.equal(misnamed.isError, true, misnamed.text)
    assert.match(JSON.parse(misnamed.text).error, /unknown key "filePaths"[\s\S]*files/)
    const wrong = await client.callTool('edit_systems', { op: 'add_chunk', sessionId: draft.payload.sessionId, chunkId: 'one', systems: [{ systemKey: 'storage', name: 'Wrong' }] })
    assert.equal(wrong.isError, false, wrong.text)
    const reset = await client.callTool('edit_systems', { op: 'abort_session', sessionId: draft.payload.sessionId })
    assert.equal(reset.isError, false, reset.text)
    assert.equal((await client.callTool('edit_systems', { op: 'session_status', sessionId: draft.payload.sessionId })).payload.systems.length, 0)
    const chunk = await client.callTool('edit_systems', { op: 'add_chunk', sessionId: draft.payload.sessionId, chunkId: 'one', systems: [{ systemKey: 'storage', name: 'Storage', files: ['storage/record.py'] }] })
    assert.equal(chunk.isError, false, chunk.text)
    const submitted = await client.callTool('edit_systems', { op: 'commit_session', sessionId: draft.payload.sessionId })
    assert.equal(submitted.isError, false, submitted.text)
    assert.equal(submitted.payload.final, true)
    for (const [name, args] of [['get_architecture', {}], ['start_work', {}], ['reply_to_canvas', {}], ['update_work', { note: 'Late' }], ['edit_systems', { op: 'begin_session' }]]) {
      const late = await client.callTool(name, args)
      assert.equal(late.isError, true, late.text)
      assert.match(late.text, /permanently closed/)
    }
    const proposal = await (await harnessFetch(`${h.apiBase}/api/architecture-proposals/${submitted.payload.proposalId}?workspace=${h.workspaceId}`)).json()
    assert.equal(proposal.round.evidenceSummary, 'Storage owns record persistence.')
    const attempt = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${started.binding.attempt.id}?workspace=${h.workspaceId}`)).json()
    assert.equal(attempt.state, 'submitted')
    assert.ok(!attempt.endedAt, 'a proposal alone must not assert process termination')
  } finally { client?.close(); h.stop() }
})

test('launcher closes a mapping process before confirming review, and Stop revokes writes first', { timeout: 60000 }, async () => {
  const saved = { ...process.env }
  const h = await startHarness()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-mapping-runner-'))
  const runner = new DeliveryRunner(dir)
  let client
  try {
    process.env.AMBIO_API_URL = h.apiBase
    process.env.AMBIO_API_TOKEN = 'ambio-isolated-test-token-for-mcp-harness'
    delete process.env.AMBIO_MAPPING_ATTEMPT
    const started = await begin(h); client = started.client
    const run = await runner.start({ workspaceId: h.workspaceId, messageId: started.messageId, hostId: 'codex', rootPath: h.projectDir, revision: 'initial', launcher: { command: process.execPath, args: [] }, args: ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], prompt: '', mapping: started.binding })
    const draft = await client.callTool('edit_systems', { op: 'begin_session' })
    await client.callTool('edit_systems', { op: 'add_chunk', sessionId: draft.payload.sessionId, chunkId: 'one', systems: [{ systemKey: 'storage', name: 'Storage', files: ['storage/record.py'] }] })
    assert.equal((await client.callTool('edit_systems', { op: 'commit_session', sessionId: draft.payload.sessionId })).isError, false)
    for (let i = 0; i < 200 && runner.list(h.workspaceId).find(item => item.key === run.key)?.state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(runner.list(h.workspaceId).find(item => item.key === run.key)?.state, 'completed')
    const settled = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${started.binding.attempt.id}?workspace=${h.workspaceId}`)).json()
    assert.ok(settled.endedAt)
    assert.equal(settled.state, 'submitted')
    assert.equal(runner.session(h.workspaceId, started.messageId, 'codex'), undefined, 'mapping must not seed a resumable work session')
    client.close()
    const next = await begin(h); client = next.client
    const running = await runner.start({ workspaceId: h.workspaceId, messageId: next.messageId, hostId: 'codex', rootPath: h.projectDir, revision: 'initial', launcher: { command: process.execPath, args: [] }, args: ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], prompt: '', mapping: next.binding })
    const restarted = new DeliveryRunner(dir)
    await restarted.recoverMappings(h.workspaceId)
    const recovered = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${next.binding.attempt.id}?workspace=${h.workspaceId}`)).json()
    assert.equal(recovered.state, 'cancelled')
    assert.ok(recovered.endedAt, 'a recovered process must be stopped before settling')
    assert.equal(restarted.list(h.workspaceId).find(item => item.key === running.key).state, 'stopped')
    const late = await client.callTool('edit_systems', { op: 'begin_session' })
    assert.equal(late.isError, true)
    assert.match(late.text, /permanently closed/)
  } finally { await runner.stopAll(); client?.close(); h.stop(); process.env = saved; fs.rmSync(dir, { recursive: true, force: true }) }
})
