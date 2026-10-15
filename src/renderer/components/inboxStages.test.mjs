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

test('a turn reads as the person wrote it, with the kind of turn it was', async () => {
  const { turnRequest, workOrderNote } = await import('./inboxModel.ts')
  assert.deepEqual(turnRequest({ note: workOrderNote('ask', 'Why is checkout slow?'), mode: 'ask' }), { mode: 'ask', text: 'Why is checkout slow?' })
  // A turn sent before turns carried their mode is read from its contract.
  assert.deepEqual(turnRequest({ note: workOrderNote('propose', 'Add a job queue') }), { mode: 'propose', text: 'Add a job queue' })
  assert.deepEqual(turnRequest({ note: 'Add a job queue' }), { mode: 'build', text: 'Add a job queue' })
})

test('requests that share a thread are one conversation, newest conversation first', async () => {
  const { conversations, workOrderNote } = await import('./inboxModel.ts')
  const now = 1000
  const threads = conversations([
    { id: 'b2', threadId: 'b1', note: 'Build it.', mode: 'build', status: 'queued', createdAt: 40 },
    { id: 'a1', note: 'An older, separate question', status: 'answered', createdAt: 10 },
    { id: 'b1', threadId: 'b1', note: workOrderNote('ask', 'Where is retry handled?\nIn the worker?'), mode: 'ask', status: 'answered', createdAt: 20 },
    { id: 'b3', threadId: 'b1', note: 'Never mind', status: 'cancelled', createdAt: 50 },
  ], now)
  assert.deepEqual(threads.map(thread => thread.id), ['b1', 'a1'])
  assert.deepEqual(threads[0].turns.map(turn => turn.id), ['b1', 'b2', 'b3'])
  assert.equal(threads[0].title, 'Where is retry handled?')
  // The conversation stands where its latest turn that still counts stands.
  assert.equal(threads[0].stage, 'waiting')
  // A request with no thread is a conversation of one.
  assert.equal(threads[1].turns.length, 1)
  assert.equal(threads[1].stage, 'review')
})

test('the conversation menu counts conversations by where each stands', async () => {
  const { conversationStageCounts } = await import('./inboxModel.ts')
  assert.deepEqual(conversationStageCounts([{ stage: 'review' }, { stage: 'review' }, { stage: 'working' }]),
    { waiting: 0, working: 1, review: 2, accepted: 0, cancelled: 0 })
})

test('a handoff for a chat Ambio cannot start asks it to stay attached; a plain one does not', async () => {
  const { workOrderHandoff, STAY_ATTACHED } = await import('../../shared/workOrderHandoff.ts')
  const plain = workOrderHandoff('Shop', 'ws', '/shop', 'order-1')
  const attached = workOrderHandoff('Shop', 'ws', '/shop', 'order-1', { stayAttached: true })
  assert.ok(!plain.includes('watch: true'))
  assert.equal(attached, `${plain} ${STAY_ATTACHED}`)
  assert.match(attached, /get_inbox with watch: true/)
})
