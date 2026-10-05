import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSheetMembers, sheetMembersFor } from './sheetFromSelection.ts'

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
