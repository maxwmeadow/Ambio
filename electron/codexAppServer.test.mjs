import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer, codexAppServerPolicy, codexAccessLevels, codexServerVersion } from './codexAppServer.ts'
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
        else if (message.method === 'initialize') client.receive(JSON.stringify({ id: message.id, result: { userAgent: 'Codex Desktop/0.162.1 (Windows; ambio)' } }))
        else if (message.method === 'thread/start' || message.method === 'thread/resume') client.receive(JSON.stringify({ id: message.id, result: { thread: { id: 'thread' }, approvalPolicy: message.params.approvalPolicy, approvalsReviewer: message.params.approvalsReviewer, sandbox: { type: message.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly' } } }))
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
  assert.ok(args.some(arg => arg.startsWith('mcp_servers={') && arg.includes('"AMBIO_API_TOKEN"="scoped-token"')))
  assert.ok(args.some(arg => arg.includes('"AMBIO_RUN_MESSAGE_ID"="request"')))
  assert.ok(args.some(arg => arg.includes('--ambio-host=codex')))
  assert.ok(!args.includes('exec') && !args.includes('--json') && !args.includes('-') && !args.includes('secret prompt'))
})

test('handshake, native thread configuration and streamed activity retain identity, output, diffs and usage', async t => {
  const f = fixture(t, { model: 'chosen', approval: 'on-request' })
  const { outcome } = await running(f)
  assert.deepEqual(f.sent.slice(0, 3).map(m => m.method), ['initialize', 'initialized', 'thread/start'])
  assert.deepEqual(f.sent[2].params, { cwd: process.cwd(), ...codexAppServerPolicy('build', 'on-request', process.platform, 'user', 'codex/0.162.1'), model: 'chosen' })
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

// Shape from codex model/list (GPT-6.1-Sol): each model advertises its own efforts and default.
test('each model offers the reasoning efforts it advertises, with its own default', async t => {
  const f = fixture(t, {}, m => m.method === 'model/list' ? { data: [
    { model: 'sol', displayName: 'Sol', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }] },
    { model: 'plain', displayName: 'Plain' },
  ], nextCursor: null } : undefined)
  const [sol, plain] = await f.client.models()
  assert.deepEqual(sol.thinkingLevels, [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'xhigh', label: 'Extra high' }])
  assert.equal(sol.defaultThinking, 'medium')
  assert.equal(plain.thinkingLevels, undefined)
  // The chosen effort rides on the turn; without one the thread keeps its own.
  for (const effort of ['xhigh', undefined]) {
    const run = fixture(t, { model: 'sol', ...(effort ? { effort } : {}) })
    const { outcome } = await running(run)
    assert.equal(run.sent.find(m => m.method === 'turn/start').params.effort, effort)
    run.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
  }
})

test('Ask me and Auto retain sandbox boundaries; unknown versions never gain Auto or Windows fallback access', () => {
  assert.deepEqual(codexAppServerPolicy('build', 'on-request', 'win32', 'user', 'codex/0.162.1'), { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', config: { sandbox_workspace_write: { network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true }, windows: { sandbox: 'unelevated' } } })
  assert.deepEqual(codexAppServerPolicy('build', 'on-request', 'linux'), { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', config: { sandbox_workspace_write: { network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } })
  assert.deepEqual(codexAppServerPolicy('ask', 'never', 'darwin'), { sandbox: 'read-only', approvalPolicy: 'never' })
  assert.deepEqual(codexAppServerPolicy('ask', 'on-request', 'win32', 'auto_review', 'codex/0.162.1').sandbox, 'read-only')
  for (const version of ['codex/0.162.0', 'codex/0.99.999', 'codex/0.162.1-beta', 'unknown', 'codex/0.162', 'codex/00.162.1', 'codex/0.162.2-alpha-foo.01', 'codex/0.162.1oops']) {
    assert.deepEqual(codexAccessLevels(version), ['ask', 'full'])
    assert.throws(() => codexAppServerPolicy('build', 'on-request', 'win32', 'user', version), /not been qualified/)
  }
  assert.equal(codexServerVersion('Codex Desktop/0.162.1 (Windows; ambio)'), '0.162.1')
  assert.deepEqual(codexAccessLevels('codex/0.162.1'), ['ask', 'auto', 'full'])
  for (const version of ['0.162.1+build.2', '0.162.2', '0.162.10', '0.163.0', '0.163.0-beta.1', '0.200.0', '1.0.0', '99.0.0']) {
    assert.deepEqual(codexAccessLevels(`codex/${version}`), ['ask', 'auto', 'full'])
    assert.equal(codexAppServerPolicy('build', 'on-request', 'win32', 'auto_review', `codex/${version}`).sandbox, 'workspace-write')
  }
})

test('Auto selects the native reviewer and requires a confirmed effective sandbox before sending input', async t => {
  const f = fixture(t, { approval: 'on-request', reviewer: 'auto_review' })
  const { outcome } = await running(f)
  assert.equal(f.sent.find(m => m.method === 'thread/start').params.approvalsReviewer, 'auto_review')
  f.notify('item/autoApprovalReview/started', { reviewId: 'r', review: { status: 'inProgress' } })
  f.notify('item/autoApprovalReview/completed', { reviewId: 'r', review: { status: 'approved', rationale: 'Safe read' } })
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
  assert.equal(f.events.find(e => e.id === 'codex:review:r').text, 'Auto review · approved · Safe read')
  const weakened = fixture(t, { approval: 'on-request' }, m => m.method === 'thread/start' ? { thread: { id: 'thread' }, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } : undefined)
  await assert.rejects(weakened.client.run(), /did not confirm/)
  assert.ok(!weakened.sent.some(m => m.method === 'turn/start'))
})

test('child agent activity identifies the sender, receiver, task and lifecycle, without leaking unrelated threads', async t => {
  const f = fixture(t)
  const { outcome } = await running(f)
  f.notify('thread/started', { thread: { id: 'child', parentThreadId: 'thread', agentNickname: 'Ada', agentRole: 'explorer' } })
  f.notify('item/completed', { item: { id: 'spawn', type: 'collabAgentToolCall', senderThreadId: 'thread', receiverThreadIds: ['child'], tool: 'spawnAgent', status: 'completed', agentsStates: { child: { status: 'running' } }, prompt: 'Inspect source' } })
  f.notify('item/completed', { item: { id: 'activity', type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/explorer', kind: 'completed' } })
  f.notify('item/started', { threadId: 'child', turnId: 'child-turn', item: { id: 'child-shell', type: 'commandExecution', command: 'rg entrypoint', status: 'inProgress', aggregatedOutput: 'source.ts' } })
  f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'child-shell', type: 'commandExecution', command: 'rg entrypoint', status: 'completed', exitCode: 0 } })
  f.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'private-text', type: 'agentMessage', text: 'Child transcript' } })
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
  assert.match(f.events.find(e => e.id === 'codex:spawn').text, /Subagent · Main agent · spawnAgent → Ada · explorer \(running\) · Inspect source/)
  assert.equal(f.events.find(e => e.id === 'codex:activity').text, 'Subagent · Ada · explorer · completed')
  assert.equal(f.events.find(e => e.id === 'codex:child:child-shell').text, 'Subagent · Ada · explorer · Shell · rg entrypoint')
  assert.equal(f.events.find(e => e.id === 'codex:child:child-shell').output, 'source.ts')
  assert.ok(!f.events.some(e => e.text === 'Child transcript'))
})

test('long native turns keep all item identities beyond the old 390/400 cutoffs', async t => {
  const f = fixture(t); const { outcome } = await running(f)
  for (let i = 0; i < 1200; i++) f.notify('item/completed', { item: { id: `item-${i}`, type: 'agentMessage', text: `Item ${i}` } })
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
  assert.equal(f.events.length, 1200)
  assert.equal(f.events.at(-1).text, 'Item 1199')
})

test('completed flushed items leave the live cache while active output and every emitted item survive', async t => {
  const f = fixture(t); const { outcome } = await running(f)
  f.notify('item/started', { item: { id: 'active', type: 'commandExecution', command: 'long task', status: 'inProgress' } })
  f.notify('item/commandExecution/outputDelta', { itemId: 'active', delta: 'before ' })
  for (let i = 0; i < 4500; i++) {
    f.notify('item/completed', { item: { id: `done-${i}`, type: 'agentMessage', text: `Item ${i}` } })
    if (i % 100 === 0) f.client.flush()
  }
  f.client.flush()
  assert.ok(f.client.items.size <= 2000)
  assert.ok(!f.client.items.has('done-0'))
  assert.ok(f.client.items.has('active'))
  f.notify('item/commandExecution/outputDelta', { itemId: 'active', delta: 'after' })
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
  assert.equal(new Set(f.events.map(event => event.id)).size, 4501)
  assert.equal(f.events.filter(event => event.id === 'codex:active').at(-1).output, 'before after')
})

test('structured questions map text-keyed desk answers to Codex ids and never allow a command', async t => {
  let asked
  const f = fixture(t, { approve: async question => { asked = question; return { answers: { 'Pick a color': 'Blue', 'Explain why': 'My own answer, with commas' } } } })
  const { outcome } = await running(f)
  f.request('item/tool/requestUserInput', { questions: [{ id: 'color', question: 'Pick a color', header: 'Color', options: [{ label: 'Blue', description: 'Cool' }] }, { id: 'why', question: 'Explain why', options: null }] })
  await tick()
  assert.equal(asked.kind, 'question')
  assert.deepEqual(asked.questions[0], { question: 'Pick a color', header: 'Color', options: [{ label: 'Blue', description: 'Cool' }] })
  assert.deepEqual(f.sent.find(m => m.id === 'approval').result, { answers: { color: { answers: ['Blue'] }, why: { answers: ['My own answer, with commas'] } } })
  f.request('item/commandExecution/requestApproval', { command: 'do something' }, 'command')
  await tick(); assert.equal(f.sent.find(m => m.id === 'command').result.decision, 'decline')
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
})

test('questions decline on denial, invalid answers, callback failure, wrong owner and cancellation', async t => {
  for (const respond of [async () => false, async () => true, async () => ({ answers: {} }), async () => { throw new Error('timeout') }]) {
    const f = fixture(t, { approve: respond }); const { outcome } = await running(f)
    f.request('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Proceed?' }] }); await tick()
    assert.match(f.sent.find(m => m.id === 'approval').error.message, /declined/)
    f.request('item/tool/requestUserInput', { threadId: 'other', questions: [{ id: 'q', question: 'Proceed?' }] }, 'foreign')
    assert.ok(f.sent.find(m => m.id === 'foreign').error)
    f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
  }
  const f = fixture(t, { approve: () => new Promise(() => {}) }); const { outcome } = await running(f)
  f.request('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Proceed?' }] }); await tick()
  f.client.cancel(); await tick()
  assert.ok(f.sent.find(m => m.id === 'approval').error)
  f.notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } }); await outcome
})

test('a resolved question never gets a second reply from a late desk answer', async t => {
  let finish, asks = 0
  const f = fixture(t, { approve: () => { asks++; return new Promise(resolve => { finish = resolve }) } })
  const { outcome } = await running(f)
  f.request('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Proceed?' }] })
  f.request('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Proceed?' }] })
  await tick(); assert.equal(asks, 1)
  f.notify('serverRequest/resolved', { requestId: 'approval' })
  finish({ answers: { 'Proceed?': 'Yes' } }); await tick()
  assert.ok(!f.sent.some(message => message.id === 'approval'))
  f.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await outcome
})
