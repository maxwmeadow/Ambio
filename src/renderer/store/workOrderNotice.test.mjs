import assert from 'node:assert/strict'
import test from 'node:test'
import { workOrderNotice } from './workOrderNotice.ts'

const order = (patch = {}) => ({
  id: 'wo1', workspaceId: 'ws', sheetId: 's', sentSheetName: 'Payment flow', note: 'Build it',
  status: 'queued', deliveredTo: null, createdAt: 1, ...patch,
})

test('sending says nothing; a pickup and a reply each say so once', () => {
  assert.equal(workOrderNotice(undefined, order()), null)
  const claimed = order({ status: 'delivered', agent: 'Codex' })
  assert.deepEqual(workOrderNotice(order(), claimed), {
    title: 'Codex picked up “Payment flow”', body: 'You will be told when it replies.', tag: 'work-order:wo1',
  })
  assert.equal(workOrderNotice(claimed, claimed), null)
  const answered = order({ status: 'answered', reply: { agent: 'Codex', body: '\nAdded the Payments system.\nDetails…', createdAt: 9 } })
  assert.equal(workOrderNotice(claimed, answered).title, 'Codex replied to “Payment flow”')
  assert.equal(workOrderNotice(claimed, answered).body, 'Added the Payments system.')
  assert.equal(workOrderNotice(answered, answered), null)
  // A second reply after a reopen is news again.
  const again = order({ status: 'answered', reply: { agent: 'Codex', body: 'Fixed.', createdAt: 12 } })
  assert.equal(workOrderNotice(answered, again).body, 'Fixed.')
})

test("the person's own review and cancelling say nothing", () => {
  const answered = order({ status: 'answered', reply: { agent: 'Codex', body: 'Done', createdAt: 9 } })
  assert.equal(workOrderNotice(answered, { ...answered, review: { id: 'r', decision: 'accepted', note: '', createdAt: 10 } }), null)
  assert.equal(workOrderNotice(order(), order({ status: 'cancelled' })), null)
})

test('an order without a sheet is named by its note', () => {
  const claimed = order({ sentSheetName: undefined, note: 'Make the code match the map\n- move x', status: 'delivered' })
  assert.equal(workOrderNotice(undefined, claimed).title, 'An agent picked up “Make the code match the map”')
})
