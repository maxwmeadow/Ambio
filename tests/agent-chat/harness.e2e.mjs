import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { AgentChat } from '../../electron/agentChat.ts'
import { ChatProviders } from '../../electron/chatProviders.ts'
import { ChatProviderProxy } from '../../electron/chatProviderProxy.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const binary = path.join(ROOT, 'out', 'agent', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(manager, id, predicate) {
  let snapshot
  for (let i = 0; i < 150; i++) { snapshot = await manager.snapshot(id); if (predicate(snapshot)) return snapshot; if (snapshot.conversation.state === 'failed') assert.fail(JSON.stringify(snapshot)); await sleep(100) }
  assert.fail(`Timed out: ${JSON.stringify(snapshot)}`)
}

test('real OpenCode: configured service, MCP, multi-turn history, approvals, read-only tools, cancellation and restart', { timeout: 90000 }, async t => {
  assert.ok(fs.existsSync(binary), 'Build the pinned harness with npm run build:agent')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-chat-harness-'))
  const root = path.join(directory, 'project'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'hello.txt'), 'original')
  const requests = []
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    assert.equal(req.headers.authorization, 'Bearer fixture-provider-key')
    const last = body.messages?.filter(message => message.role === 'user').at(-1)
    const user = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
    const completedTool = body.messages?.some(message => message.role === 'tool')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (user?.includes('slow-turn')) { emit({ role: 'assistant', content: 'Starting a long response…' }); const timer = setTimeout(() => { emit({}, 'stop'); res.end('data: [DONE]\n\n') }, 20000); res.on('close', () => clearTimeout(timer)); return }
    if ((user?.includes('approval-turn') || user?.includes('architecture-tool-turn') || user?.includes('question-turn')) && !completedTool) {
      const name = user.includes('architecture-tool-turn') ? 'ambio_get_architecture' : user.includes('question-turn') ? 'question' : 'write'
      const args = name === 'write' ? { filePath: path.join(root, 'hello.txt'), content: 'modified' } : name === 'question' ? { questions: [{ header: 'Approach', question: 'Which approach?', options: [{ label: 'Small', description: 'Small change' }, { label: 'Large', description: 'Large change' }] }] } : {}
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      emit({}, 'tool_calls')
    } else { emit({ role: 'assistant', content: completedTool ? 'The requested action was handled.' : 'Hello from the configured model service.' }); emit({}, 'stop') }
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`
  const providers = new ChatProviders(path.join(directory, 'chat'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const profile = providers.save({ kind: 'compatible', name: 'Fixture service', baseUrl, model: 'fixture-model', apiKey: 'fixture-provider-key' })
  assert.deepEqual((await providers.test({ ...profile, apiKey: '' })).models, ['fixture-model'])
  let manager
  const makeManager = () => new AgentChat({ directory: path.join(directory, 'chat'), binary, providers, proxy: new ChatProviderProxy(providers), project: id => ({ id, rootPath: root, name: 'Fixture' }), mcp: () => ({ command: process.execPath, args: [path.join(ROOT, 'tests', 'agent-chat', 'mcp-fixture.mjs')] }), assertExternalIdle: () => {}, workOrder: async () => 'Implement the requested small fixture change.' })
  manager = makeManager()
  t.after(async () => { await manager.close(); model.closeAllConnections(); model.close(); await sleep(100); fs.rmSync(directory, { recursive: true, force: true }) })
  const conversation = await manager.create('fixture', profile.id)
  await assert.rejects(manager.send({ conversationId: conversation.id, text: 'Unbound change', mode: 'build' }), /requires an addressed/ )
  await manager.send({ conversationId: conversation.id, text: 'hello-turn', mode: 'ask' })
  let result = await until(manager, conversation.id, value => value.conversation.state === 'idle' && value.messages.some(message => message.role === 'assistant'))
  assert.match(JSON.stringify(result.messages), /Hello from the configured model service/)
  const firstRequest = requests.find(request => JSON.stringify(request.messages).includes('hello-turn'))
  assert.ok(firstRequest)
  const askTools = (firstRequest.tools ?? []).map(tool => tool.function.name)
  assert.equal(askTools.includes('write'), false); assert.equal(askTools.includes('bash'), false); assert.equal(askTools.includes('task'), false); assert.equal(askTools.includes('ambio_edit_sheet'), false)
  assert.ok(askTools.includes('ambio_get_architecture'), 'Read-only MCP tool is available')
  await manager.send({ conversationId: conversation.id, text: 'follow-up-turn', mode: 'ask' })
  result = await until(manager, conversation.id, value => value.conversation.state === 'idle' && value.messages.filter(message => message.role === 'assistant').length >= 2)
  assert.equal(result.messages.filter(message => message.role === 'user').length, 2)
  const acknowledged = await manager.create('fixture', profile.id)
  const originalCall = manager.call.bind(manager)
  manager.call = async (...args) => {
    const result = await originalCall(...args)
    if (args[1].endsWith('/prompt_async')) throw new Error('Fixture lost acknowledgement')
    return result
  }
  await assert.rejects(manager.send({ conversationId: acknowledged.id, text: 'acknowledgement-turn', mode: 'ask' }), /acknowledgement was lost/)
  manager.call = originalCall
  await assert.rejects(manager.send({ conversationId: acknowledged.id, text: 'duplicate-turn', mode: 'ask' }), /Wait for this turn/)
  await until(manager, acknowledged.id, value => value.conversation.state === 'idle')
  assert.equal(manager.cached(acknowledged.id).messages.filter(message => message.role === 'user').length, 1)
  const architecture = await manager.create('fixture', profile.id)
  await manager.send({ conversationId: architecture.id, text: 'architecture-tool-turn', mode: 'ask' })
  const architectureResult = await until(manager, architecture.id, value => value.conversation.state === 'idle')
  assert.match(JSON.stringify(architectureResult.messages), /UI depends on Storage/)
  const question = await manager.create('fixture', profile.id)
  await manager.send({ conversationId: question.id, text: 'question-turn', mode: 'ask' })
  const questionRequest = await until(manager, question.id, value => value.questions.length)
  await manager.answer(question.id, questionRequest.questions[0].id, [['Small']])
  await until(manager, question.id, value => value.conversation.state === 'idle')
  const build = await manager.create('fixture', profile.id)
  await manager.send({ conversationId: build.id, text: 'approval-turn', mode: 'build', workOrderId: 'fixture-work-order' })
  const approval = await until(manager, build.id, value => value.approvals.length)
  assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'original')
  await assert.rejects(manager.send({ conversationId: conversation.id, text: 'overlapping-turn', mode: 'build', workOrderId: 'fixture-work-order' }), /working in this project/)
  await assert.rejects(manager.approve(conversation.id, approval.approvals[0].id, true), /no longer pending/)
  await manager.approve(build.id, approval.approvals[0].id, false)
  await until(manager, build.id, value => value.conversation.state === 'idle')
  assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'original')
  const allowed = await manager.create('fixture', profile.id)
  await manager.send({ conversationId: allowed.id, text: 'approval-turn', mode: 'build', workOrderId: 'fixture-work-order' })
  const allowedRequest = await until(manager, allowed.id, value => value.approvals.length)
  await manager.approve(allowed.id, allowedRequest.approvals[0].id, true)
  await until(manager, allowed.id, value => value.conversation.state === 'idle')
  assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'modified')
  await manager.send({ conversationId: conversation.id, text: 'slow-turn', mode: 'ask' })
  await until(manager, conversation.id, value => JSON.stringify(value.messages).includes('Starting a long response'))
  await manager.stop(conversation.id)
  assert.equal(manager.cached(conversation.id).conversation.state, 'interrupted')
  const count = requests.length; await manager.close(); manager = makeManager()
  const restored = await manager.snapshot(conversation.id)
  assert.ok(restored.messages.length >= 5); assert.equal(restored.conversation.state, 'interrupted')
  await sleep(200); assert.equal(requests.length, count, 'Restart does not resend a turn')
  const recovery = makeManager()
  await assert.rejects(recovery.snapshot(conversation.id), /previous integrated agent is still running/)
  assert.throws(() => recovery.assertRootAvailable(root), /previous integrated agent/)
  await recovery.stop(conversation.id)
  await manager.close(); manager = recovery
  await manager.snapshot(conversation.id)
  assert.equal(requests.length, count, 'Recovering an orphan does not replay inference')
  await manager.close()
  const receiptPath = path.join(directory, 'chat', 'runtime', createHash('sha256').update('fixture').digest('hex'), 'process.json')
  fs.writeFileSync(receiptPath, JSON.stringify({ pid: process.pid, stamp: 'a-different-process-creation-time', rootPath: root, binary }))
  manager = makeManager()
  await manager.snapshot(conversation.id)
  assert.equal(requests.length, count, 'A recycled PID is discarded without terminating an unrelated process')
})
