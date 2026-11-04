import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer, codexAppServerPolicy } from './codexAppServer.ts'
import { agentDriver, codexSandbox } from './agentDrivers.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, overrides = {}, handle = () => undefined) {
  const sent = [], events = [], usages = [], sessions = [], ready = []
  const client = new CodexAppServer({
    cwd: process.cwd(), prompt: 'Claim Ambio request', mode: 'build',
    onEvent: e => events.push(e), onUsage: u => usages.push(u), onSession: id => sessions.push(id), onReady: value => ready.push(value),
    send: line => {
      const message = JSON.parse(line); sent.push(message)
      queueMicrotask(() => {
        const result = handle(message, client)
        if (result !== undefined) client.receive(JSON.stringify({ id: message.id, result }))
        else if (message.method === 'initialize') client.receive(JSON.stringify({ id: message.id, result: { userAgent: 'codex/fixture' } }))
        else if (message.method === 'thread/start' || message.method === 'thread/resume') client.receive(JSON.stringify({ id: message.id, result: { thread: { id: 'thread' } } }))
        else if (message.method === 'turn/start' || message.method === 'review/start') client.receive(JSON.stringify({ id: message.id, result: { turn: { id: message.method === 'review/start' ? 'review' : 'turn' } } }))
      })
    }, ...overrides,
  })
  t.after(() => client.close())
  const notify = (method, params = {}) => client.receive(JSON.stringify({ method, params: { threadId: 'thread', turnId: 'turn', ...params } }))
  const request = (method, params = {}, id = 'approval') => client.receive(JSON.stringify({ id, method, params: { threadId: 'thread', turnId: 'turn', itemId: 'shell', ...params } }))
  return { client, sent, events, usages, sessions, ready, notify, request }
}
async function running(f) { const outcome = f.client.run(); await tick(); return { outcome } }

test('native launch preserves MCP, model, mapping credential and host identity without exec flags', () => {
  const args = agentDriver('codex').appServerArgs({ hostId: 'codex', mode: 'ask', mcp: { command: 'node', args: ['mcp.js'] }, workspaceId: 'workspace', prompt: 'secret prompt', messageId: 'request', model: 'chosen', mapping: { attempt: { id: 'attempt' }, token: 'scoped-token' } })
  assert.equal(args[0], 'app-server')
  assert.ok(args.includes('mcp_servers.ambio.env.AMBIO_API_TOKEN="scoped-token"'))
  assert.ok(args.includes('mcp_servers.ambio.env.AMBIO_RUN_MESSAGE_ID="request"'))
  assert.ok(args.some(arg => arg.includes('--ambio-host=codex')))
  assert.ok(!args.includes('exec') && !args.includes('--json') && !args.includes('-') && !args.includes('secret prompt'))
})

test('handshake, native thread configuration and streamed activity retain identity, output, diffs and usage', async t => {
  const f = fixture(t, { model: 'chosen', approval: 'on-request' })
  const { outcome } = await running(f)
  assert.deepEqual(f.sent.slice(0, 3).map(m => m.method), ['initialize', 'initialized', 'thread/start'])
  assert.deepEqual(f.sent[2].params, { cwd: process.cwd(), ...codexAppServerPolicy('build', 'on-request'), model: 'chosen' })
  assert.deepEqual(f.sessions, ['thread'])
  f.notify('item/agentMessage/delta', { itemId: 'message', delta: 'Hello ' })
  f.notify('item/agentMessage/delta', { itemId: 'message', delta: 'world' })
  f.notify('item/started', { item: { type: 'commandExecution', id: 'shell', command: 'npm test', status: 'inProgress' } })
  f.notify('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'passed' })
  f.notify('item/completed', { item: { type: 'commandExecution', id: 'shell', command: 'npm test', status: 'completed', exitCode: 0 } })
  f.notify('item/completed', { item: { type: 'fileChange', id: 'edit', changes: [{ path: 'a.ts', diff: '+fixed' }], status: 'completed' } })
  f.notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 } } })
  // Other threads and stale turn completions cannot settle this run.
  f.notify('turn/completed', { turnId: 'old', turn: { id: 'old', status: 'failed' } })
  f.notify('item/agentMessage/delta', { threadId: 'other', itemId: 'message', delta: 'wrong' })
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  assert.deepEqual(await outcome, { stopReason: 'completed', resumed: false })
  assert.equal(f.events.find(e => e.id === 'codex:message').text, 'Hello world')
  assert.equal(f.events.find(e => e.id === 'codex:shell').output, 'passed')
  assert.equal(f.events.find(e => e.id === 'codex:shell').exitCode, 0)
  assert.match(f.events.find(e => e.id === 'codex:edit').diff, /a.ts\n\+fixed/)
  assert.equal(f.usages[0].totalTokens, 12)
  assert.equal(f.ready.at(-1), false)
})

test('resume is exact and failure never creates a replacement thread or starts a prompt', async t => {
  const f = fixture(t, { resume: 'missing' }, (m, client) => {
    if (m.method === 'thread/resume') { client.receive(JSON.stringify({ id: m.id, error: { message: 'thread not found' } })); return null }
  })
  await assert.rejects(f.client.run(), /thread not found/)
  assert.equal(f.sent.find(m => m.method === 'thread/resume').params.threadId, 'missing')
  assert.ok(!f.sent.some(m => ['turn/start', 'thread/start'].includes(m.method)))
})

test('Ask/Propose preserve platform sandbox and refuse file approval; scoped command approvals expire', async t => {
  let signal, answer
  const f = fixture(t, { mode: 'ask', approve: async (_question, abort) => { signal = abort; return new Promise(resolve => { answer = resolve }) } })
  const { outcome } = await running(f)
  assert.equal(f.sent.find(m => m.method === 'thread/start').params.sandbox, codexSandbox('ask'))
  f.request('item/fileChange/requestApproval')
  assert.equal(f.sent.at(-1).result.decision, 'decline')
  f.request('item/commandExecution/requestApproval', { command: 'ls' }, 'command')
  await tick()
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  assert.equal(signal.aborted, true)
  answer(true); await tick(); await outcome
  assert.ok(!f.sent.some(m => m.id === 'command' && m.result?.decision === 'accept'))
})

test('command approvals go through the callback once and accept only a live owning request', async t => {
  let asks = 0
  const f = fixture(t, { approve: async question => { asks++; assert.match(question.detail, /npm test/); return true } })
  const { outcome } = await running(f)
  f.request('item/commandExecution/requestApproval', { command: 'npm test' })
  f.request('item/commandExecution/requestApproval', { command: 'npm test' })
  await tick()
  assert.equal(asks, 1)
  assert.equal(f.sent.filter(m => m.id === 'approval' && m.result?.decision === 'accept').length, 1)
  f.request('item/commandExecution/requestApproval', { threadId: 'other' }, 'foreign')
  assert.equal(f.sent.at(-1).result.decision, 'decline')
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
})

test('steer targets the active turn; Stop sends interrupt and blocks further input', async t => {
  const f = fixture(t, {}, m => m.method === 'turn/steer' ? { turnId: 'turn' } : m.method === 'turn/interrupt' ? {} : undefined)
  await assert.rejects(f.client.steer('too soon'), /not accepting/)
  const { outcome } = await running(f)
  await f.client.steer('Keep the public API')
  assert.deepEqual(f.sent.find(m => m.method === 'turn/steer').params, { threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'Keep the public API' }] })
  f.client.cancel()
  assert.equal(f.sent.at(-1).method, 'turn/interrupt')
  await assert.rejects(f.client.steer('too late'), /not accepting/)
  f.notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } })
  assert.equal((await outcome).stopReason, 'interrupted')
})

test('native review finishes before the Ambio handoff, on the same thread', async t => {
  const f = fixture(t, { review: true })
  const { outcome } = await running(f)
  assert.ok(!f.sent.some(m => m.method === 'turn/start'))
  f.notify('item/completed', { turnId: 'review', item: { id: 'review-item', type: 'exitedReviewMode', review: 'One actionable finding' } })
  f.notify('turn/completed', { turnId: 'review', turn: { id: 'review', status: 'completed' } })
  await tick()
  const handoff = f.sent.find(m => m.method === 'turn/start')
  assert.equal(handoff.params.threadId, 'thread')
  assert.match(handoff.params.input[0].text, /Claim Ambio request[\s\S]*One actionable finding/)
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
})

test('discovery paginates the server model list without opening a thread', async t => {
  const f = fixture(t, {}, m => m.method === 'model/list' ? { data: [{ model: m.params.cursor ? 'two' : 'one', displayName: 'Name' }], nextCursor: m.params.cursor ? null : 'next' } : undefined)
  assert.deepEqual((await f.client.models()).map(m => m.id), ['one', 'two'])
  assert.ok(!f.sent.some(m => m.method === 'thread/start'))
})

test('Ask me honors Windows full access and requests human command approvals; other platforms retain sandboxing', () => {
  assert.deepEqual(codexAppServerPolicy('build', 'on-request', 'win32'), { sandbox: 'danger-full-access', approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
  assert.deepEqual(codexAppServerPolicy('build', 'on-request', 'linux'), { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  assert.deepEqual(codexAppServerPolicy('ask', 'never', 'darwin'), { sandbox: 'read-only', approvalPolicy: 'never' })
})
