import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { chatGPTRequest, chatGPTEvents } from './chatgptResponses.ts'
import { ChatProviders } from './chatProviders.ts'
import { ChatProviderProxy } from './chatProviderProxy.ts'

test('subscription requests retain history, use non-stored streaming and group local tools', () => {
  const original = { model: 'model', input: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }, { type: 'function_call_output', call_id: 'one', output: 'tool result' }], store: true, stream: false, previous_response_id: 'old', max_output_tokens: 2000, temperature: 1, tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], tool_choice: { type: 'function', name: 'read' } }
  const body = chatGPTRequest(original)
  assert.equal(body.store, false); assert.equal(body.stream, true)
  for (const field of ['previous_response_id', 'max_output_tokens', 'temperature']) assert.equal(field in body, false)
  assert.equal(body.input[0].role, 'developer'); assert.deepEqual(body.input[2], original.input[2])
  assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].tools[0].name, 'read')
  assert.equal(body.tool_choice.namespace, body.tools[0].name)
  assert.equal(original.input[0].role, 'system'); assert.equal(original.store, true)
  assert.throws(() => chatGPTRequest({ model: 'model', input: [] , tools: [{ type: 'tool_search' }] }), /not available/)
})

async function events(parts) {
  const body = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(Buffer.from(part)); controller.close() } })
  let output = ''; for await (const event of chatGPTEvents(body)) output += event
  return output
}
test('SSE completion is required and usage failures produce an actionable error', async () => {
  const completed = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
  assert.equal(await events([completed.slice(0, 15), completed.slice(15)]), completed)
  assert.match(await events(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n']), /chatgpt_stream_incomplete/)
  assert.match(await events(['data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n']), /Manage usage/)
  assert.match(await events(['data: {"type":"response.incomplete"}\n\n']), /"type":"error"/)
  assert.match(await events(['data: {"type":"response.completed","response":{"status":"failed"}}\n\n']), /chatgpt_response_incomplete/)
})

export function subscriptionFixture() {
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const other = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const state = { activeId: other, profiles: [{ id, label: 'Connection 1', connected: true, sharing: true, model: 'subscription-model', models: ['subscription-model'] }, { id: other, label: 'Connection 2', connected: true, sharing: true, model: 'other-model', models: ['other-model'] }] }
  let calls = 0
  const source = { state: () => state, authorize: async profileId => { assert.equal(profileId, id); if (!state.profiles[0].sharing) throw new Error('ChatGPT plan usage is not enabled'); return `subscription-token-${++calls}` } }
  return { id, state, source }
}

test('native subscription providers resolve the conversation account, renew only in Electron and cannot be edited as API keys', async t => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'ambio-subscription-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { id, state, source } = subscriptionFixture()
  const providers = new ChatProviders(directory, { available: () => false }, fetch, source)
  assert.equal(providers.get(id).auth, 'chatgpt')
  assert.equal(JSON.stringify(providers.list()).includes('subscription-token'), false)
  assert.throws(() => providers.save({ ...providers.get(id), apiKey: 'wrong' }), /sign-in controls/)
  assert.throws(() => providers.remove(id), /Sign out/)
  let calls = 0
  const proxy = new ChatProviderProxy(providers, async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses')
    assert.equal(init.headers.Authorization, `Bearer subscription-token-${calls}`)
    const body = JSON.parse(init.body)
    assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.max_output_tokens, undefined)
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const origin = await proxy.start(); t.after(() => proxy.close())
  const request = path => fetch(`${origin}/${id}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model: 'subscription-model', input: [], max_output_tokens: 100 }) })
  assert.equal((await request('/chat/completions')).status, 400)
  assert.equal((await request('/responses?redirect=elsewhere')).status, 400)
  for (let index = 0; index < 2; index++) assert.match(await (await request('/responses')).text(), /response.completed/)
  assert.equal(calls, 2)
  state.profiles[0].sharing = false
  assert.equal((await request('/responses')).status, 502)
  assert.equal(calls, 2, 'no fallback to another account or API billing')
})
