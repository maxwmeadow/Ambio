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

test('a question and a proposal carry their contract; a build is the order as written', async () => {
  const { workOrderNote } = await import('./inboxModel.ts')
  assert.match(workOrderNote('ask', 'Why is checkout slow?'), /^This is a question\..*\n\nWhy is checkout slow\?$/s)
  assert.match(workOrderNote('propose', 'Add a job queue'), /wait for me to confirm before changing any code\.\n\nAdd a job queue$/)
  assert.equal(workOrderNote('build', 'Add a job queue'), 'Add a job queue')
})
