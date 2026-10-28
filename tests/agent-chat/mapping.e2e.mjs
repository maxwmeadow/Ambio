import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import test from 'node:test'
import { AgentChat } from '../../electron/agentChat.ts'
import { ChatProviders } from '../../electron/chatProviders.ts'
import { ChatProviderProxy } from '../../electron/chatProviderProxy.ts'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('native mapping stops its real runtime at submit and cannot resume as ordinary work', { timeout: 90000 }, async () => {
  const saved = { ...process.env }
  const h = await startHarness()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-native-mapping-'))
  let manager
  const requests = []
  const model = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'mapping-fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const hasTool = body.messages?.some(message => message.role === 'tool')
    if (!hasTool) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'map_fixture', type: 'function', function: { name: 'ambio_edit_systems', arguments: JSON.stringify({ op: 'propose', rationale: 'Storage owns persisted records', systems: [{ systemKey: 'storage', name: 'Storage', files: ['storage/record.py'] }] }) } }] })
      emit({}, 'tool_calls')
    } else { emit({ role: 'assistant', content: 'Mapping submitted.' }); emit({}, 'stop') }
    response.end('data: [DONE]\n\n')
  })
  try {
    process.env.AMBIO_API_URL = h.apiBase
    process.env.AMBIO_API_TOKEN = 'ambio-isolated-test-token-for-mcp-harness'
    delete process.env.AMBIO_MAPPING_ATTEMPT
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    const providers = new ChatProviders(path.join(directory, 'chat'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
    const profile = providers.save({ kind: 'compatible', name: 'Mapping fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture-model', apiKey: 'fixture-key' })
    const post = (route, body) => harnessFetch(`${h.apiBase}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceId: h.workspaceId }) })
    const made = await (await post('/api/mapping-attempts', {})).json()
    manager = new AgentChat({ directory: path.join(directory, 'chat'), binary: path.join(ROOT, 'out', 'agent', process.platform === 'win32' ? 'opencode.exe' : 'opencode'), providers, proxy: new ChatProviderProxy(providers), project: id => ({ id, rootPath: h.projectDir, name: 'Mapping fixture' }), mcp: () => ({ command: process.execPath, args: [path.join(ROOT, 'mcp', 'ambio-mcp.ts')] }), assertExternalIdle: () => {}, workOrder: async () => { throw new Error('Mapping must not start work orders') }, mappingCredentials: async (_workspace, id) => (await post(`/api/mapping-attempts/${id}/credentials`, {})).json() })
    const conversation = await manager.create(h.workspaceId, profile.id, undefined, made.attempt.id)
    await manager.send({ conversationId: conversation.id, text: 'Map the fixture. Submit the architecture as your final action.', mode: 'propose' })
    let attempt
    for (let i = 0; i < 150; i++) {
      await manager.snapshot(conversation.id)
      attempt = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${made.attempt.id}?workspace=${h.workspaceId}`)).json()
      if (attempt.endedAt) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(attempt.state, 'submitted', JSON.stringify(manager.cached(conversation.id)))
    assert.ok(attempt.endedAt, 'native process shutdown was not confirmed')
    for (const request of requests) {
      const tools = request.tools?.map(tool => tool.function?.name) ?? []
      assert.ok(!tools.includes('write') && !tools.includes('bash') && !tools.includes('ambio_start_work') && !tools.includes('ambio_edit_sheet'), tools.join(','))
    }
    await assert.rejects(manager.send({ conversationId: conversation.id, text: 'Continue working', mode: 'propose' }), /single finite turn/)
    const before = requests.length
    await manager.snapshot(conversation.id)
    await manager.snapshot(conversation.id)
    assert.equal(requests.length, before, 'returning to the mapping replay restarted inference')
    assert.equal(manager.cached(conversation.id).conversation.state, 'idle')
    // An old replay must not dispose a later ordinary chat runtime.
    await manager.create(h.workspaceId, profile.id)
    const ordinary = manager.runtimes.get(h.workspaceId)
    await manager.snapshot(conversation.id)
    assert.equal(manager.runtimes.get(h.workspaceId), ordinary)
    await manager.close()
    // Recover the startup crash window: a runtime receipt exists but the
    // renderer never received/persisted the native conversation id.
    const next = await (await post('/api/mapping-attempts', {})).json()
    manager = new AgentChat({ ...manager.options })
    await manager.create(h.workspaceId, profile.id, undefined, next.attempt.id)
    const orphan = manager
    fs.writeFileSync(path.join(directory, 'chat', 'conversations.json'), '[]')
    manager = new AgentChat({ ...orphan.options })
    assert.equal(await manager.recoverMapping(h.workspaceId, next.attempt.id), true)
    const recovered = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${next.attempt.id}?workspace=${h.workspaceId}`)).json()
    assert.equal(recovered.state, 'cancelled')
    assert.ok(recovered.endedAt, 'an interrupted startup was never settled')
    await orphan.close()
    const failed = await (await post('/api/mapping-attempts', {})).json()
    const unavailable = new AgentChat({ ...manager.options, binary: path.join(directory, 'missing-runtime') })
    await assert.rejects(unavailable.create(h.workspaceId, profile.id, undefined, failed.attempt.id), /runtime is missing/)
    const closed = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${failed.attempt.id}?workspace=${h.workspaceId}`)).json()
    assert.equal(closed.state, 'cancelled')
    assert.ok(closed.endedAt, 'a launch failure stranded its mapping attempt')
    await unavailable.close()

  } finally {
    await manager?.close()
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
    h.stop(); process.env = saved; fs.rmSync(directory, { recursive: true, force: true })
  }
})
