import assert from 'node:assert/strict'
import test from 'node:test'
import { createSheetPresentation } from './sheetPresentation.ts'

const node = id => ({ id, position: { x: 0, y: 0 }, data: { label: id, detailRevealed: false, childrenVisible: 0 }, hidden: false })

test('sheet presentation preserves nodes and callbacks across Floor zoom and selection', () => {
  const project = createSheetPresentation()
  const rename = () => {}
  const base = [node('a'), node('b')]
  base[0].data.onRename = rename
  const movable = new Set(['a'])
  const floor = base.map(n => ({ ...n, data: { ...n.data, runtime: null } }))
  const first = project(base, floor, new Set(), movable)
  const zoomedFloor = floor.map(n => ({ ...n, data: { ...n.data, detailRevealed: true, childrenVisible: 1 } }))
  const normalized = project(base, floor, new Set(), movable)
  assert.equal(project(base, zoomedFloor, new Set(), movable), normalized)
  const selected = project(base, zoomedFloor, new Set(['a']), movable)
  assert.notEqual(selected[0], normalized[0])
  assert.equal(selected[1], normalized[1])
  assert.equal(selected[0].data.onRename, rename)
  assert.equal(first[0].draggable, true)
  assert.equal(first[1].draggable, false)
})

test('runtime changes and clearing selection propagate only to the affected sheet node', () => {
  const project = createSheetPresentation()
  const base = [node('a'), node('b')]
  const movable = new Set(['a', 'b'])
  const first = project(base, base, new Set(['a']), movable)
  const runtime = { callCount: 3 }
  const updated = project(base, [{ ...base[0], data: { ...base[0].data, runtime } }, base[1]], new Set(), movable)
  assert.equal(updated[0].selected, false)
  assert.equal(updated[0].data.runtime, runtime)
  assert.equal(updated[1], first[1])
  const removed = project([base[1]], base, new Set(), movable)
  assert.deepEqual(removed.map(n => n.id), ['b'])
})

test('hidden sheet members stay non-draggable and geometry changes replace presentation', () => {
  const project = createSheetPresentation()
  const base = [node('a')]
  const movable = new Set(['a'])
  const first = project(base, base, new Set(), movable)
  const hidden = [{ ...base[0], hidden: true, position: { x: 42, y: 7 } }]
  const next = project(hidden, base, new Set(), movable)
  assert.notEqual(next[0], first[0])
  assert.equal(next[0].draggable, false)
  assert.equal(next[0].position.x, 42)
})

test('sheet measurements survive camera and selection projections without mutating layout', () => {
  const project = createSheetPresentation()
  const base = [node('a'), node('b')]
  const measurements = new Map([['a', { width: 220, height: 110 }]])
  const movable = new Set(['a', 'b'])
  const first = project(base, base, new Set(), movable, measurements)
  const zoomed = base.map(n => ({ ...n, data: { ...n.data, detailRevealed: true } }))
  const next = project(zoomed, base, new Set(['b']), movable, measurements)
  assert.equal(next[0].measured, first[0].measured)
  assert.equal(next[0].measured.width, 220)
  assert.equal(base[0].measured, undefined)
  assert.equal(next[1].measured, undefined)
})
