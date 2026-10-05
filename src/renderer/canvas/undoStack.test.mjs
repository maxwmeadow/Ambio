import assert from 'node:assert/strict'
import test from 'node:test'
import { canRedo, canUndo, clearUndo, forgetUndo, pushUndo, redoNext, undoLast } from './undoStack.ts'

const entry = (label, log, failUndo = false) => ({
  label,
  undo: async () => { if (failUndo) throw new Error('changed since'); log.push(`undo ${label}`) },
  redo: async () => { log.push(`redo ${label}`) },
})

test('undo and redo walk the stack in order, and a new change clears redo', async () => {
  clearUndo()
  const log = []
  pushUndo(entry('a', log))
  pushUndo(entry('b', log))
  assert.equal(await undoLast(), 'b')
  assert.equal(await undoLast(), 'a')
  assert.equal(await undoLast(), null)
  assert.equal(await redoNext(), 'a')
  pushUndo(entry('c', log))
  assert.equal(canRedo(), false)
  assert.deepEqual(log, ['undo b', 'undo a', 'redo a'])
})

test('a refused undo stays where it was', async () => {
  clearUndo()
  pushUndo(entry('x', [], true))
  await assert.rejects(undoLast(), /changed since/)
  assert.equal(canUndo(), true)
  assert.equal(canRedo(), false)
})

test('an entry undone elsewhere is forgotten', async () => {
  clearUndo()
  const log = []
  const first = entry('first', log)
  pushUndo(first)
  pushUndo(entry('second', log))
  forgetUndo(first)
  assert.equal(await undoLast(), 'second')
  assert.equal(await undoLast(), null)
})
