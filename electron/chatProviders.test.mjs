import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import test from 'node:test'
import { ChatProviders, providerUrl } from './chatProviders.ts'
import { ChatProviderProxy } from './chatProviderProxy.ts'
import { chatAgentConfig, normalizeChatMessages } from './agentChat.ts'

const secure = { available: () => true, encrypt: value => Buffer.from(`encrypted:${value}`), decrypt: value => value.toString().slice(10) }
const ephemeral = { available: () => false, encrypt: () => { throw Error('Unavailable') }, decrypt: () => { throw Error('Unavailable') } }
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-chat-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const input = { kind: 'openai', name: 'My service', baseUrl: 'https://api.example.com/v1', model: 'model-one', apiKey: 'test-provider-secret' }

test('provider keys are encrypted at rest, hidden from UI and recovered through the keychain', t => {
  const dir = fixture(t); const store = new ChatProviders(dir, secure)
  const profile = store.save(input)
  assert.equal(profile.hasKey, true); assert.equal(profile.persistentKey, true)
  assert.equal(JSON.stringify(store.list()).includes(input.apiKey), false)
  assert.equal(new ChatProviders(dir, secure).key(profile.id), input.apiKey)
  assert.equal(store.save({ ...input, id: profile.id, apiKey: '' }).hasKey, true)
  assert.throws(() => store.save({ ...input, id: profile.id, baseUrl: 'https://other.example/v1', apiKey: '' }), /new service URL/)
  store.remove(profile.id); assert.deepEqual(store.list(), [])
})

test('unavailable keychains keep keys only in memory and do not claim persistence', t => {
  const dir = fixture(t); const store = new ChatProviders(dir, ephemeral); const profile = store.save(input)
  assert.equal(profile.persistentKey, false); assert.equal(profile.hasKey, true)
  assert.equal(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8').includes(input.apiKey), false)
  assert.equal(new ChatProviders(dir, ephemeral).get(profile.id).hasKey, false)
})

test('provider URLs forbid embedded credentials and insecure remote transport', () => {
  assert.throws(() => providerUrl('http://example.com/v1'), /HTTPS/)
  assert.throws(() => providerUrl('https://user:secret@example.com/v1'), /credentials/)
  assert.throws(() => providerUrl('https://example.com?key=secret'), /query/)
  assert.equal(providerUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1')
})

test('connection checks authenticate and enumerate real model results without echoing errors', async t => {
  const store = new ChatProviders(fixture(t), ephemeral, async (url, options) => {
    assert.equal(url, `${input.baseUrl}/models`); assert.equal(options.headers.Authorization, `Bearer ${input.apiKey}`); assert.equal(options.redirect, 'error')
    return Response.json({ data: [{ id: 'z' }, { id: 'a' }] })
  })
  assert.deepEqual((await store.test(input)).models, ['a', 'z'])
  const saved = store.save(input)
  await assert.rejects(store.test({ ...input, id: saved.id, apiKey: '', baseUrl: 'https://other.example/v1' }), /new service URL/)
})

test('credential proxy rejects unrelated local callers, injects real keys upstream, and streams the response', async t => {
  const store = new ChatProviders(fixture(t), ephemeral); const profile = store.save(input)
  let calls = 0
  const proxy = new ChatProviderProxy(store, async (url, options) => { calls++; assert.equal(url, `${input.baseUrl}/chat/completions`); assert.equal(options.headers.Authorization, `Bearer ${input.apiKey}`); assert.equal(options.redirect, 'error'); return new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream' } }) })
  t.after(() => proxy.close()); const origin = await proxy.start()
  assert.equal((await fetch(`${origin}/${profile.id}/chat/completions`)).status, 401)
  assert.equal(calls, 0)
  const response = await fetch(`${origin}/${profile.id}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: '{}' })
  assert.equal(response.status, 200); assert.equal(await response.text(), 'data: hello\n\n'); assert.equal(calls, 1)
})

test('credential proxy redacts upstream credential echoes across stream chunks', async t => {
  const store = new ChatProviders(fixture(t), ephemeral); const profile = store.save(input)
  const proxy = new ChatProviderProxy(store, async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(`data: before ${input.apiKey.slice(0, 8)}`))
    controller.enqueue(Buffer.from(`${input.apiKey.slice(8)} after\n\n`)); controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  t.after(() => proxy.close()); const origin = await proxy.start()
  const response = await fetch(`${origin}/${profile.id}/chat/completions`, { headers: { Authorization: `Bearer ${proxy.token}` } })
  assert.equal(await response.text(), 'data: before [redacted] after\n\n')
})

test('Ask denies shell, edits, delegation and all unknown tools; Build requests approvals', () => {
  const ask = chatAgentConfig('ask').permission
  assert.equal(ask['*'], 'deny'); assert.equal(ask.read, 'allow'); assert.equal(ask.ambio_get_architecture, 'allow')
  assert.equal(ask.bash, undefined); assert.equal(ask.edit, undefined); assert.equal(ask.task, undefined)
  const build = chatAgentConfig('build').permission
  assert.equal(build['*'], 'ask'); assert.equal(build.external_directory, 'deny'); assert.equal(build.task, 'deny')
})

test('message normalization renders text and tool activity while excluding hidden reasoning and synthetic context', () => {
  const result = normalizeChatMessages([{ info: { id: 'm', role: 'assistant' }, parts: [{ id: 'a', type: 'text', text: 'Hello' }, { id: 'b', type: 'reasoning', text: 'private' }, { id: 'c', type: 'text', text: 'injected', synthetic: true }, { id: 'd', type: 'tool', tool: 'read', state: { status: 'completed', output: 'source' } }] }])
  assert.equal(result[0].parts.length, 2); assert.equal(result[0].parts[1].text, 'source')
})
