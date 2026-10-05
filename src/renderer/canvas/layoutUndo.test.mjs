import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutUndoEntry } from './layoutUndo.ts'
import { pushUndo, redoNext, undoLast, clearUndo } from './undoStack.ts'

const row = (nodeId, positionX) => ({
  nodeId, nodeType: 'system', parentNodeId: null, parentNodeType: null, containmentKind: 'root',
  positionX, positionY: 0, width: 200, height: 100, scale: 1, interiorScale: 1,
})

test('a move undoes to where the nodes were, and redoes back', async () => {
  clearUndo()
  const saved = []
  const entry = layoutUndoEntry({
    label: 'Move', before: [{ ...row('a', 10), workspaceId: 'ws', updatedAt: 1 }], after: [row('a', 90), row('new', 5)],
    save: async rows => { saved.push(rows.map(r => `${r.nodeId}@${r.positionX}`).join(',')) },
  })
  pushUndo(entry)
  assert.equal(await undoLast(), 'Move')
  assert.equal(await redoNext(), 'Move')
  // The node placed for the first time has nothing to go back to.
  assert.deepEqual(saved, ['a@10', 'a@90'])
})

test('nothing changed, or nothing had a place before, is not undoable', () => {
  const save = async () => {}
  assert.equal(layoutUndoEntry({ label: 'Move', before: [row('a', 10)], after: [row('a', 10)], save }), null)
  assert.equal(layoutUndoEntry({ label: 'Move', before: [], after: [row('a', 10)], save }), null)
})
