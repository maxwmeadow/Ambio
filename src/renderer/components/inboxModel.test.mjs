import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasReference, referenceTarget, messageReferences, inboxStatus } from './inboxModel.ts'
test('canvas references keep identity separate from mutable, Unicode display labels', () => {
  const first = canvasReference('file', 'stable/identifier', 'src/日本語 & payments.ts')
  assert.deepEqual(referenceTarget(first), { id: 'stable/identifier', label: 'src/日本語 & payments.ts' })
  assert.equal(referenceTarget(canvasReference('file', 'stable/identifier', 'renamed')).id, referenceTarget(first).id)
  assert.equal(referenceTarget(canvasReference('planned', 'plan', 'Plan')).id, 'planned:plan')
  assert.deepEqual(messageReferences('malformed'), [])
})
test('a claim is never displayed as proof that the agent is actively working', () => {
  assert.equal(inboxStatus({ status: 'delivered', agent: 'Codex', leaseExpiresAt: 200 }, 100), 'Picked up by Codex')
  assert.match(inboxStatus({ status: 'delivered', leaseExpiresAt: 200 }, 201), /expired/)
  assert.equal(inboxStatus({ status: 'answered' }), 'Answered')
})
