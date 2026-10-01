import assert from 'node:assert/strict'
import test from 'node:test'
import { describeDropEdits, meaningEditsForDrop } from './floorMeaning.ts'

const ownership = {
  fileSystem: new Map([['billing', 'orders'], ['cart', 'orders'], ['loose', null]]),
  systemParent: new Map([['orders', null], ['payments', null], ['refunds', 'orders']]),
}
const into = (nodeId, nodeType, parentNodeId) => ({
  nodeId, nodeType, parentNodeId, parentNodeType: parentNodeId ? 'system' : null,
  containmentKind: parentNodeId ? 'part_of' : 'root',
})

test('dropping files into another system moves them there, in one edit', () => {
  const edits = meaningEditsForDrop([into('billing', 'file', 'payments'), into('cart', 'file', 'payments')], ownership)
  assert.deepEqual(edits, [{ op: 'assign', fileIds: ['billing', 'cart'], systemId: 'payments' }])
})

test('rearranging inside the same system is presentation, not meaning', () => {
  assert.deepEqual(meaningEditsForDrop([into('billing', 'file', 'orders'), into('refunds', 'system', 'orders')], ownership), [])
})

test('open canvas means no system; systems nest and un-nest by placement', () => {
  assert.deepEqual(meaningEditsForDrop([into('billing', 'file', null)], ownership),
    [{ op: 'assign', fileIds: ['billing'], systemId: null }])
  assert.deepEqual(meaningEditsForDrop([into('payments', 'system', 'orders'), into('refunds', 'system', null)], ownership), [
    { op: 'nest', systemId: 'payments', parentId: 'orders' },
    { op: 'nest', systemId: 'refunds', parentId: null },
  ])
})

test('hosting and unknown nodes imply nothing', () => {
  const hosted = { nodeId: 'billing', nodeType: 'file', parentNodeId: 'docker', parentNodeType: 'infra', containmentKind: 'hosted_by' }
  assert.deepEqual(meaningEditsForDrop([hosted, into('planned-1', 'file', 'payments')], ownership), [])
})

test('the confirmation says what now belongs where', () => {
  const names = { file: id => `${id}.ts`, system: id => id ? id[0].toUpperCase() + id.slice(1) : 'no system' }
  assert.equal(
    describeDropEdits([{ op: 'assign', fileIds: ['billing'], systemId: 'payments' }, { op: 'nest', systemId: 'refunds', parentId: null }], names),
    'billing.ts now belongs to Payments; Refunds moved to the top level',
  )
})
