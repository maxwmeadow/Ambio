const fs = require('node:fs')
const readline = require('node:readline')
const version = '0.162.1'
if (process.argv.includes('--version')) {
  fs.writeSync(1, `codex-cli ${version}\n`)
  process.exit(0)
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const session = 'codex-fixture-thread'
let turn = '', nextTurn = 0
let captured
const capture = () => {
  fs.writeFileSync('captured-codex.tmp', JSON.stringify(captured))
  fs.renameSync('captured-codex.tmp', 'captured-codex.json')
}
const mode = () => { try { return JSON.parse(fs.readFileSync('codex-fixture-mode.json', 'utf8')).mode } catch { return 'complete' } }
const notify = (method, params) => send({ method, params: { threadId: session, turnId: turn, ...params } })
const complete = (status = 'completed') => {
  notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 15 } } })
  notify('item/completed', { item: { id: 'shell', type: 'commandExecution', command: 'fixture check', aggregatedOutput: 'check passed', exitCode: 0, status: 'completed' } })
  notify('turn/completed', { turn: { id: turn, status } })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  const reply = result => send({ id: m.id, result })
  if (m.method === 'initialize') return reply({ userAgent: `codex/${version}` })
  if (m.method === 'model/list') return reply({ data: [{ model: 'fixture', displayName: 'Fixture model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null })
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    captured = { args: process.argv.slice(2), cwd: process.cwd(), workspace: process.env.AMBIO_WORKSPACE_ID, setup: m.params, resumed: m.method === 'thread/resume', corrections: [] }
    return reply({ thread: { id: m.params.threadId ?? session }, approvalPolicy: m.params.approvalPolicy, approvalsReviewer: m.params.approvalsReviewer, sandbox: { type: m.params.sandbox === 'workspace-write' ? 'workspaceWrite' : m.params.sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess' } })
  }
  if (m.method === 'review/start') {
    turn = `review-${++nextTurn}`; captured.review = m.params; capture()
    reply({ turn: { id: turn } }); notify('turn/started', { turn: { id: turn } })
    notify('item/completed', { item: { id: 'review-result', type: 'exitedReviewMode', review: 'Fixture native review found no issues.' } })
    return notify('turn/completed', { turn: { id: turn, status: 'completed' } })
  }
  if (m.method === 'turn/start') {
    turn = `turn-${++nextTurn}`
    captured.prompt = m.params.input[0].text; captured.turn = turn; captured.effort = m.params.effort; capture()
    reply({ turn: { id: turn } }); notify('turn/started', { turn: { id: turn } })
    notify('item/agentMessage/delta', { itemId: 'text', delta: 'Fixture is reading ' })
    setTimeout(() => notify('item/agentMessage/delta', { itemId: 'text', delta: 'the project.' }), 180)
    notify('item/started', { item: { id: 'shell', type: 'commandExecution', command: 'fixture check', status: 'inProgress' } })
    if (captured.setup.approvalsReviewer === 'auto_review') {
      notify('item/autoApprovalReview/started', { reviewId: 'auto-1', review: { status: 'inProgress' } })
      notify('item/autoApprovalReview/completed', { reviewId: 'auto-1', review: { status: 'approved', rationale: 'Harmless fixture operation.' } })
    }
    if (mode() === 'history') for (let i = 0; i < 4500; i++) notify('item/completed', { item: { id: `step-${i}`, type: 'agentMessage', text: `History item ${i}` } })
    if (mode() === 'subagent') {
      send({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: session, agentNickname: 'Reviewer', agentRole: 'explorer' } } })
      notify('item/completed', { item: { id: 'collab', type: 'collabAgentToolCall', senderThreadId: session, receiverThreadIds: ['child'], tool: 'spawnAgent', status: 'completed', prompt: 'Inspect the fixture', agentsStates: { child: { status: 'completed' } } } })
    }
    if (mode() === 'approval') return send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: session, turnId: turn, itemId: 'shell', command: 'fixture check', cwd: process.cwd(), reason: 'Fixture access request' } })
    if (mode() === 'question') return send({ id: 901, method: 'item/tool/requestUserInput', params: { threadId: session, turnId: turn, itemId: 'question', questions: [{ id: 'color', header: 'Color', question: 'Which color should the fixture use?', isOther: true, isSecret: false, options: [{ label: 'Blue', description: 'Use the cool color' }, { label: 'Red', description: 'Use the warm color' }] }, { id: 'reason', header: 'Reason', question: 'Why this color?', isOther: true, isSecret: false, options: null }] } })
    if (mode() === 'fail') return setTimeout(() => { notify('turn/completed', { turn: { id: turn, status: 'failed', error: { message: 'Fixture quota error' } } }); process.exitCode = 0 }, 300)
    if (mode() !== 'hold') setTimeout(() => complete(), 350)
    return
  }
  if (m.method === 'turn/steer') {
    captured.corrections.push(m.params); capture(); reply({ turnId: turn })
    if (mode() !== 'hold') complete()
    return
  }
  if (m.method === 'turn/interrupt') { captured.interrupted = true; capture(); reply({}); return complete('interrupted') }
  if (m.id === 900 && m.result) { captured.decision = m.result.decision; capture(); return complete() }
  if (m.id === 901) { captured.questionReply = m.result ?? m.error; capture(); return complete() }
}).on('close', () => process.exit())
