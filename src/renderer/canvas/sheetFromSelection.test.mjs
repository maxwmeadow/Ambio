import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSheetMembers, sheetMembersFor, sheetSelectionLayouts } from './sheetFromSelection.ts'

const map = {
  systems: [{ id: 'sys_pay' }],
  files: [{ id: 'f1' }, { id: 'f2' }],
  infraNodes: [{ id: 'redis' }],
}

test('a selection becomes members of every kind, systems first', () => {
  const members = sheetMembersFor(['f1', 'redis', 'planned:x', 'sys_pay', 'f1', 'gone'], map)
  assert.deepEqual(members, [{ systemId: 'sys_pay' }, { fileId: 'f1' }, { infraId: 'redis' }])
  assert.equal(describeSheetMembers(members), '1 system, 1 file and 1 infrastructure node')
})

test('the dialog names what it will draw', () => {
  assert.equal(describeSheetMembers(sheetMembersFor(['f1', 'f2'], map)), '2 files')
  assert.equal(describeSheetMembers([]), 'nothing')
})

function node(id, x, y, width, height, parentId, data = {}) {
  return { id, type: 'system', position: { x, y }, style: { width, height }, parentId, data }
}

test('a selection preserves exact relative offsets, dimensions and scale', () => {
  const nodes = [node('left', -340, 180, 620, 420), node('above', 590, -35, 410, 305), node('right', 1410, 380, 300, 160)]
  const layouts = sheetSelectionLayouts([{ systemId: 'above' }, { systemId: 'left' }, { systemId: 'right' }], nodes)
  assert.deepEqual(layouts.map(({ positionX, positionY, width, height }) => [positionX, positionY, width, height]), [
    [930, 0, 410, 305], [0, 215, 620, 420], [1750, 415, 300, 160],
  ])
  assert.deepEqual(sheetSelectionLayouts([], nodes), [])
})

test('a nested selection uses world geometry and keeps selected ancestors intact', () => {
  const nodes = [
    node('outer', 200, 400, 600, 500, undefined, { interiorScale: 0.5 }),
    node('inner', 50, 80, 150, 100, 'outer', { frameScale: 1, worldScale: 0.5 }),
    node('other', 420, 560, 100, 80),
  ]
  const [inner, other] = sheetSelectionLayouts([{ systemId: 'inner' }, { systemId: 'other' }], nodes)
  assert.deepEqual([inner.parentNodeId, inner.positionX, inner.positionY, inner.width, inner.scale], [null, 0, 0, 300, 0.5])
  assert.deepEqual([other.positionX, other.positionY], [170, 80])
  const [, nested] = sheetSelectionLayouts([{ systemId: 'outer' }, { systemId: 'inner' }], nodes)
  assert.deepEqual([nested.parentNodeId, nested.positionX, nested.positionY, nested.width, nested.scale], ['outer', 100, 160, 300, 1])
})
