import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'

test('humans and agents share revisioned notes on Floor and sheets', { timeout: 90000 }, async () => {
  const harness = await startHarness()
  try {
    const { client, workspaceId, apiBase } = harness
    const proposed = await client.callTool('edit_sheet', { op: 'create', name: 'Shared comments' })
    assert.equal(proposed.isError, false, proposed.text)
    const sheet = proposed.payload?.created?.id
    assert.ok(sheet)
    const owner = await client.callTool('edit_systems', { op: 'create', name: 'Note owner' })
    assert.equal(owner.isError, false, owner.text)
    const ownerId = owner.payload.systemId ?? owner.payload.id
    for (const surface of ['floor', sheet]) {
      const created = await client.callTool('edit_sheet', { op: 'annotate', sheet: surface, body: 'Agent explanation', positionX: 120, positionY: 90 })
      assert.equal(created.isError, false, created.text)
      const note = created.payload
      assert.equal(note.author, 'agent')
      const url = `${apiBase}/api/annotations/${note.id}?workspace=${workspaceId}`
      const human = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: note.revision, body: 'Human clarification', updatedBy: 'user' }) })
      assert.equal(human.status, 200, await human.clone().text())
      const listed = await client.callTool('edit_sheet', { op: 'notes', sheet: surface })
      assert.equal(listed.isError, false, listed.text)
      assert.equal(listed.payload.length, 1)
      assert.equal(listed.payload[0].body, 'Human clarification')
      assert.equal(listed.payload[0].author, 'agent')
      const stale = await client.callTool('edit_sheet', { op: 'edit_note', sheet: surface, noteId: note.id, revision: 1, body: 'Stale agent text' })
      assert.equal(stale.isError, true)
      const edited = await client.callTool('edit_sheet', { op: 'edit_note', sheet: surface, noteId: note.id, revision: 2, body: 'Shared explanation', positionX: 180, width: 320, height: 220, parentNodeId: ownerId })
      assert.equal(edited.isError, false, edited.text)
      assert.equal(edited.payload.updatedBy, 'agent')
      assert.equal(edited.payload.width, 320)
      assert.equal(edited.payload.layout.nodeType, 'note')
      assert.equal(edited.payload.layout.parentNodeId, ownerId)
      const wrongSurface = await client.callTool('edit_sheet', { op: 'delete_note', sheet: surface === 'floor' ? sheet : 'floor', noteId: note.id, revision: 3 })
      assert.equal(wrongSurface.isError, true)
      const removed = await client.callTool('edit_sheet', { op: 'delete_note', sheet: surface, noteId: note.id, revision: 3 })
      assert.equal(removed.isError, false, removed.text)
      const after = await client.callTool('edit_sheet', { op: 'notes', sheet: surface })
      assert.deepEqual(after.payload, [])
    }
  } finally { await harness.stop() }
})
