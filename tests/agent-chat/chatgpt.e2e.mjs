import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentChat } from '../../electron/agentChat.ts'
import { ChatProviders } from '../../electron/chatProviders.ts'
import { ChatProviderProxy } from '../../electron/chatProviderProxy.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const binary = path.join(ROOT, 'out', 'agent', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function streamResponse(request, tool = false) {
  const item = tool
    ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'ambio_get_architecture', namespace: 'ambio_local_tools', arguments: '{}', status: 'completed' }
    : { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native ChatGPT subscription reply.', annotations: [] }] }
  const response = { id: `resp_${Date.now()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: request.model, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, ...(tool ? { arguments: '' } : { content: [], status: 'in_progress' }) } },
    ...(tool ? [{ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' }, { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: '{}' }]
      : [{ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Native ChatGPT subscription reply.' }, { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'Native ChatGPT subscription reply.' }]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  return new Response(events.map((event, index) => `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

test('real native OpenCode chat uses ChatGPT OAuth through the public Responses route, tools and full follow-up history', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-native-chatgpt-'))
  const root = path.join(directory, 'project'); fs.mkdirSync(root)
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', token = 'fixture-subscription-token'
  const source = {
    state: () => ({ profiles: [{ id, label: 'Connection 1', model: 'subscription-model', models: ['subscription-model'], sharing: true }] }),
    authorize: async requested => { assert.equal(requested, id); return token },
  }
  const providers = new ChatProviders(path.join(directory, 'chat'), { available: () => false }, fetch, source)
  const requests = []
  let failStream = false
  let omitContentType = false
  const proxy = new ChatProviderProxy(providers, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    const body = JSON.parse(init.body); requests.push(body)
    assert.equal(body.stream, true); assert.equal(body.store, false)
    assert.equal(body.previous_response_id, undefined); assert.equal(body.max_output_tokens, undefined)
    assert.ok(body.tools.some(tool => tool.type === 'namespace' && tool.tools.some(item => item.name === 'ambio_get_architecture')))
    if (failStream === 'limit') return new Response('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    if (failStream === 'slow') {
      const complete = await streamResponse(body).text()
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(complete.slice(0, complete.lastIndexOf('data: {"type":"response.completed"'))))
        init.signal.addEventListener('abort', () => { try { controller.error(new Error('Stopped')) } catch {} }, { once: true })
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (failStream) {
      const complete = await streamResponse(body).text()
      return new Response(complete.slice(0, complete.lastIndexOf('data: {"type":"response.completed"')), { headers: { 'content-type': 'text/event-stream' } })
    }
    const response = streamResponse(body, !body.input.some(item => item.type === 'function_call_output'))
    return omitContentType ? new Response(response.body) : response
  })
  const manager = new AgentChat({ directory: path.join(directory, 'chat'), binary, providers, proxy, project: workspaceId => ({ id: workspaceId, rootPath: root }), mcp: () => ({ command: process.execPath, args: [path.join(ROOT, 'tests/agent-chat/mcp-fixture.mjs')] }), assertExternalIdle: () => {}, workOrder: async () => 'Build fixture' })
  t.after(async () => { await manager.close(); await sleep(100); fs.rmSync(directory, { recursive: true, force: true }) })
  const until = async (id, predicate) => {
    let snapshot
    for (let index = 0; index < 200; index++) {
      snapshot = await manager.snapshot(id)
      if (predicate(snapshot)) return snapshot
      if (snapshot.conversation.state === 'failed') assert.fail(JSON.stringify(snapshot))
      await sleep(100)
    }
    assert.fail(`Timed out: ${JSON.stringify(snapshot)}`)
  }
  const conversation = await manager.create('project', id)
  await manager.send({ conversationId: conversation.id, text: 'Explain my architecture.', mode: 'ask' })
  let snapshot = await until(conversation.id, value => value.conversation.state === 'idle')
  assert.match(JSON.stringify(snapshot.messages), /Native ChatGPT subscription reply/)
  assert.ok(requests.length >= 2, 'the native agent executed the namespaced MCP tool and continued inference')
  assert.match(JSON.stringify(requests), /UI depends on Storage/)
  // Electron's live OAuth response can omit Content-Type even for valid SSE.
  omitContentType = true
  await manager.send({ conversationId: conversation.id, text: 'Remember the earlier architecture.', mode: 'ask' })
  snapshot = await until(conversation.id, value => value.conversation.state === 'idle')
  assert.match(JSON.stringify(requests.at(-1).input), /Explain my architecture/)
  assert.match(JSON.stringify(requests.at(-1).input), /Remember the earlier architecture/)
  assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 2)
  failStream = true
  await manager.send({ conversationId: conversation.id, text: 'Interrupted response test.', mode: 'ask' })
  snapshot = await until(conversation.id, value => value.conversation.state === 'failed')
  assert.match(snapshot.conversation.error, /ChatGPT did not complete/)
  const count = requests.length; await sleep(300)
  assert.equal(requests.length, count, 'the interrupted plan request is not automatically replayed')
  failStream = 'limit'
  await manager.send({ conversationId: conversation.id, text: 'Usage limit test.', mode: 'ask' })
  snapshot = await until(conversation.id, value => value.conversation.state === 'failed')
  assert.match(snapshot.conversation.error, /Manage usage/)
  assert.equal(requests.length, count + 1, 'usage limits do not trigger a billing or account fallback')
  failStream = 'slow'
  const beforeStop = requests.length
  await manager.send({ conversationId: conversation.id, text: 'Stop this response.', mode: 'ask' })
  for (let index = 0; index < 100 && requests.length === beforeStop; index++) await sleep(20)
  assert.equal(requests.length, beforeStop + 1)
  await manager.stop(conversation.id); await sleep(200)
  assert.equal(manager.cached(conversation.id).conversation.state, 'interrupted', 'user cancellation is not overwritten by a stream error')
  await manager.close()
  for (const file of fs.readdirSync(directory, { recursive: true })) {
    const target = path.join(directory, file)
    if (fs.statSync(target).isFile()) assert.equal(fs.readFileSync(target).includes(Buffer.from(token)), false, target)
  }
})
