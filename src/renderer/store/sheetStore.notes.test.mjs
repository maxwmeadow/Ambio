import assert from 'node:assert/strict'
import test from 'node:test'
import { useSheetStore, handleSheetPatch } from './sheetStore.ts'

const note = { id: 'note-a', workspaceId: 'ws', sheetId: null, targetType: null, targetId: null, body: 'Original', kind: 'note', author: 'user', positionX: 10, positionY: 20, width: 260, height: 180, revision: 1, createdAt: 1, updatedAt: 1, updatedBy: 'user' }
const reset = () => useSheetStore.setState({ workspaceId: 'ws', floorNotes: [], deletedNoteIds: {}, layersById: {}, activeSheetId: null, annotations: [] })

test('note patches preserve newest edits, separate surfaces and prevent stale resurrection', () => {
  reset()
  handleSheetPatch({ type: 'annotation:upserted', payload: { ...note, body: 'Agent edit', revision: 3, updatedBy: 'agent' } })
  handleSheetPatch({ type: 'annotation:upserted', payload: note })
  handleSheetPatch({ type: 'annotation:upserted', payload: { ...note, id: 'sheet-only', sheetId: 'unloaded-sheet' } })
  assert.equal(useSheetStore.getState().floorNotes.length, 1)
  assert.equal(useSheetStore.getState().floorNotes[0].body, 'Agent edit')
  handleSheetPatch({ type: 'annotation:deleted', payload: { id: note.id, workspaceId: 'ws' } })
  handleSheetPatch({ type: 'annotation:upserted', payload: { ...note, revision: 2 } })
  assert.equal(useSheetStore.getState().floorNotes.length, 0)
  reset()
})

test('a stale note save exposes current text without overwriting it or retrying', async () => {
  reset()
  const original = globalThis.fetch
  let request
  globalThis.fetch = async (url, init) => {
    request = JSON.parse(init.body)
    return Response.json({ error: 'This note changed', current: { ...note, body: 'Latest agent text', revision: 2 } }, { status: 409 })
  }
  try {
    await assert.rejects(useSheetStore.getState().saveAnnotation('ws', note.id, 1, { body: 'My draft' }), /note changed/)
    assert.equal(request.revision, 1)
    assert.equal(request.updatedBy, 'user')
    assert.equal(useSheetStore.getState().floorNotes[0].body, 'Latest agent text')
  } finally { globalThis.fetch = original; reset() }
})

test('surface refresh removes offline deletions while keeping edits received during the fetch', async () => {
  reset()
  useSheetStore.setState({ floorNotes: [note, { ...note, id: 'updated' }] })
  const original = globalThis.fetch
  let complete
  globalThis.fetch = () => new Promise(resolve => { complete = resolve })
  try {
    const loading = useSheetStore.getState().loadFloorNotes('ws')
    handleSheetPatch({ type: 'annotation:upserted', payload: { ...note, id: 'updated', body: 'New live edit', revision: 2 } })
    complete(Response.json([]))
    await loading
    assert.deepEqual(useSheetStore.getState().floorNotes.map(note => note.id), ['updated'])
    assert.equal(useSheetStore.getState().floorNotes[0].body, 'New live edit')
  } finally { globalThis.fetch = original; reset() }
})
