import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasReference, referenceTarget, messageReferences, inboxStatus, workOrderHandoff } from './inboxModel.ts'
test('canvas references keep identity separate from mutable, Unicode display labels', () => {
  const first = canvasReference('file', 'stable/identifier', 'src/日本語 & payments.ts')
  assert.deepEqual(referenceTarget(first), { id: 'stable/identifier', label: 'src/日本語 & payments.ts' })
  assert.equal(referenceTarget(canvasReference('file', 'stable/identifier', 'renamed')).id, referenceTarget(first).id)
  assert.equal(referenceTarget(canvasReference('planned', 'plan', 'Plan')).id, 'planned:plan')
  assert.deepEqual(messageReferences('malformed'), [])
})
test('a claim is never displayed as proof that the agent is actively working', () => {
  assert.equal(inboxStatus({ status: 'delivered', agent: 'Codex', leaseExpiresAt: 200 }, 100), 'Picked up by Codex')
  assert.equal(inboxStatus({ status: 'delivered', agent: 'Claude Code', deliveredTo: 'a1234567-1111', leaseExpiresAt: 200 }, 100), 'Picked up by Claude Code · connector a1234567')
  assert.match(inboxStatus({ status: 'delivered', leaseExpiresAt: 200 }, 201), /expired/)
  assert.equal(inboxStatus({ status: 'answered' }), 'Answered')
})
test('a handoff names the exact work order and does not invite queue draining', () => {
  const id = 'e95d997b-a73a-4e4c-b0d7-42dfbd52ed9b'
  const prompt = workOrderHandoff('Payments', 'workspace-1', '/projects/payments', id)
  assert.match(prompt, /get_inbox with messageId "e95d997b-a73a-4e4c-b0d7-42dfbd52ed9b" and expectedWorkspaceId "workspace-1"/)
  assert.match(prompt, /\/projects\/payments/)
  assert.match(prompt, /Do not claim another work order unless I ask/)
})
