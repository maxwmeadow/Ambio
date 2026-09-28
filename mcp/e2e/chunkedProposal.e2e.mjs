import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness } from './mcpHarness.mjs'

test('large architecture can be submitted in durable chunks without changing the live map', { timeout: 90000 }, async () => {
  const harness = await startHarness()
  try {
    const { client, workspaceId, apiBase } = harness
    const before = await (await fetch(`${apiBase}/api/snapshot/${workspaceId}`)).json()

    const begun = await client.callTool('edit_systems', { op: 'begin_session', rationale: 'Separate storage from the API' })
    assert.equal(begun.isError, false, begun.text)
    const sessionId = begun.payload.sessionId
    assert.ok(sessionId)

    const first = { op: 'add_chunk', sessionId, chunkId: 'storage', systems: [{
      systemKey: 'storage', name: 'Storage', files: ['storage/record.py', 'storage/task_store.py'],
    }] }
    const accepted = await client.callTool('edit_systems', first)
    assert.equal(accepted.isError, false, accepted.text)
    assert.equal(accepted.payload.systems, 1)

    const invalid = await client.callTool('edit_systems', {
      op: 'add_chunk', sessionId, chunkId: 'bad-path',
      systems: [{ systemKey: 'bad', name: 'Bad', files: ['missing.py'] }],
    })
    assert.equal(invalid.isError, true)
    assert.match(invalid.text, /missing\.py/)

    const second = await client.callTool('edit_systems', {
      op: 'add_chunk', sessionId, chunkId: 'api',
      systems: [{ systemKey: 'api', name: 'API', parentKey: 'storage', files: ['api/handlers.py'] }],
    })
    assert.equal(second.isError, false, second.text)

    const status = await client.callTool('edit_systems', { op: 'session_status', sessionId })
    assert.equal(status.isError, false, status.text)
    assert.deepEqual(status.payload.chunkIds, ['storage', 'api'])
    assert.equal(status.payload.systems.length, 2)

    const retry = await client.callTool('edit_systems', first)
    assert.equal(retry.isError, false, retry.text)
    assert.equal(retry.payload.chunks, 2)

    const mid = await (await fetch(`${apiBase}/api/snapshot/${workspaceId}`)).json()
    assert.equal(mid.systems?.length ?? 0, before.systems?.length ?? 0)

    const committed = await client.callTool('edit_systems', { op: 'commit_session', sessionId })
    assert.equal(committed.isError, false, committed.text)
    assert.equal(committed.payload.systems, 2)

    const proposal = await (await fetch(`${apiBase}/api/architecture-proposals/${committed.payload.proposalId}?workspace=${workspaceId}`)).json()
    assert.equal(proposal.round.systems.length, 2)
    assert.equal(proposal.round.systems.find(system => system.systemKey === 'api').depth, 1)
    const after = await (await fetch(`${apiBase}/api/snapshot/${workspaceId}`)).json()
    assert.equal(after.systems?.length ?? 0, before.systems?.length ?? 0, 'unreviewed proposal reached the live map')
  } finally {
    harness.stop()
  }
})
