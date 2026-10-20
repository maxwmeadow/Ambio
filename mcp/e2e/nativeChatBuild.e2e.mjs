import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'

test('native chat starts its first Build thread and retains subsequent work orders and reviews', { timeout: 90000 }, async t => {
  const harness = await startHarness()
  t.after(() => harness.stop())
  const { apiBase, workspaceId, client } = harness
  const threadId = 'chat:ses_nativeBuildSmoke'
  const send = (id, extra = {}) => fetch(`${apiBase}/api/canvas/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspaceId, threadId, mode: 'build', deliveryMode: 'addressed', note: `Implement ${id}`, ...extra }),
  })
  const first = await send('native-build-first')
  assert.equal(first.status, 200, await first.clone().text())
  const original = await first.json()
  const retried = await send('native-build-first')
  assert.equal(retried.status, 200, await retried.clone().text())
  assert.equal((await retried.json()).createdAt, original.createdAt)

  const claimed = await client.callTool('get_inbox', { messageId: original.id, expectedWorkspaceId: workspaceId })
  assert.equal(claimed.isError, false, claimed.text)
  assert.equal(claimed.payload.messages[0].threadId, threadId)
  const reply = await client.callTool('reply_to_canvas', { messageHandle: claimed.payload.messages[0].messageHandle, body: 'First native build completed.' })
  assert.equal(reply.isError, false, reply.text)
  const reviewed = await fetch(`${apiBase}/api/canvas/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, msgId: original.id, reviewId: 'native-build-review', decision: 'accepted' }),
  })
  assert.equal(reviewed.status, 200, await reviewed.clone().text())

  const second = await send('native-build-follow-up')
  assert.equal(second.status, 200, await second.clone().text())
  const followup = await client.callTool('get_inbox', { messageId: 'native-build-follow-up', expectedWorkspaceId: workspaceId })
  assert.equal(followup.isError, false, followup.text)
  assert.equal(followup.payload.messages[0].threadId, threadId)
  assert.equal(followup.payload.messages[0].conversation[0].reply, 'First native build completed.')
  assert.equal(followup.payload.messages[0].conversation[0].review, 'accepted')

  // The native exception does not let ordinary unknown threads, open requests,
  // or non-Build messages invent a conversation they are supposed to continue.
  for (const [index, extra] of [
    { threadId: 'missing-thread' },
    { threadId: 'chat:ses_open', deliveryMode: 'open' },
    { threadId: 'chat:ses_ask', mode: 'ask' },
    { threadId: 'chat:' },
  ].entries()) {
    const rejected = await send(`invalid-native-${index}`, extra)
    assert.equal(rejected.status, 409, await rejected.text())
  }
})
