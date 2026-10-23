import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeFloorLayoutUpdates, mergeLayoutParents } from './floorLayoutUpdates.ts'
const row = (id, extra = {}) => ({ nodeId: id, nodeType: 'file', workspaceId: 'demo', parentNodeId: 'parent',
  parentNodeType: 'system', containmentKind: 'part_of', positionX: 10, positionY: 20, width: 220, height: 110, scale: 1, interiorScale: 1, updatedAt: 1, ...extra })
test('timestamp-only layout echoes preserve geometry collections and semantic node identities', () => {
  const current = [row('a'), row('b')]
  assert.equal(mergeFloorLayoutUpdates(current, [row('b', { updatedAt: 22 }), row('a', { updatedAt: 23 })]), current)
  const files = [{ id: 'a', systemId: 'parent' }, { id: 'b', systemId: 'parent' }]
  assert.equal(mergeLayoutParents(files, new Map([['file:a', row('a')]]), 'file'), files)
  const moved = mergeLayoutParents(files, new Map([['file:a', row('a', { parentNodeId: 'other' })]]), 'file')
  assert.equal(moved[0].systemId, 'other'); assert.equal(moved[1], files[1])
  assert.equal(mergeLayoutParents(files, new Map([['file:a', row('a', { parentNodeId: 'infra', containmentKind: 'hosted_by' })]]), 'file'), files)
})
test('real changes and appended rows preserve stable order and do not corrupt cached lookup indexes', () => {
  const current = [row('a'), row('b')]
  const next = mergeFloorLayoutUpdates(current, [row('a', { positionX: 99 }), row('c')])
  assert.deepEqual(next.map(n => n.nodeId), ['a', 'b', 'c'])
  assert.equal(next[1], current[1]); assert.equal(current[0].positionX, 10)
  assert.equal(mergeFloorLayoutUpdates(next, [row('c', { updatedAt: 100 })]), next)
  assert.equal(mergeFloorLayoutUpdates(current, [row('a', { updatedAt: 100 })]), current)
})
