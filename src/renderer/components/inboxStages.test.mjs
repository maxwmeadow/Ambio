import assert from 'node:assert/strict'
import test from 'node:test'
import { workOrderStage, workOrderStageCounts } from './inboxModel.ts'

test('every work order lands in one stage, matching what the inbox says about it', () => {
  const now = 1000
  const orders = [
    { status: 'queued' },
    { status: 'delivered', leaseExpiresAt: 2000 },
    { status: 'delivered', leaseExpiresAt: 500 }, // claim expired: available again
    { status: 'queued', review: { decision: 'reopened' } },
    { status: 'answered' },
    { status: 'answered', review: { decision: 'accepted' } },
    { status: 'cancelled' },
  ]
  assert.deepEqual(orders.map(order => workOrderStage(order, now)),
    ['waiting', 'working', 'waiting', 'waiting', 'review', 'accepted', 'cancelled'])
  assert.deepEqual(workOrderStageCounts(orders, now), { waiting: 3, working: 1, review: 1, accepted: 1, cancelled: 1 })
})
