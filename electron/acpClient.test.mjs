import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DeliveryRunner, deliveryTargets } from './agentDelivery.ts'
import { acpModeFor, acpPermission } from './acpClient.ts'
import { agentDriver } from './agentDrivers.ts'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-acp-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function testSpawn(command, args, options) {
  const env = { ...options.env }
  delete env.NODE_TEST_CONTEXT
  return spawn(command, args, { ...options, env })
}
async function settled(runner, workspace, key) {
  for (let i = 0; i < 600; i++) {
    const run = runner.list(workspace).find(item => item.key === key)
    if (run && ['completed', 'failed', 'stopped', 'launch-failed'].includes(run.state)) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`run did not settle: ${JSON.stringify(runner.list(workspace))}`)
}

// A stand-in ACP agent. It knows one earlier session ("known"), offers three
// modes, and on every prompt asks permission to edit a file and says what it
// was told. FAIL_NEW makes it demand a sign-in instead of starting a session.
const AGENT = `
const lines = require('node:readline').createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })
const waiting = new Map()
let mode = 'agent', servers = []
const modes = () => ({ currentModeId: mode, availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] })
lines.on('line', async line => {
  const message = JSON.parse(line)
  if (message.method === undefined) { waiting.get(message.id)?.(message.result); return }
  const { id, method, params } = message
  if (method === 'initialize') {
    if (process.env.NO_ACP) { console.error('unknown option --acp'); process.exit(2) }
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
  }
  if (method === 'session/new') {
    if (process.env.FAIL_NEW) return send({ id, error: { code: -32000, message: 'Authentication required' } })
    servers = params.mcpServers
    return send({ id, result: { sessionId: 'fresh-session', modes: modes() } })
  }
  if (method === 'session/load') {
    if (params.sessionId !== 'known') return send({ id, error: { code: -32002, message: 'Session not found' } })
    servers = params.mcpServers
    update('known', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SOMETHING SAID LAST TIME' } })
    return send({ id, result: { modes: modes() } })
  }
  if (method === 'session/set_mode') { mode = params.modeId; return send({ id, result: {} }) }
  if (method === 'session/prompt') {
    const sessionId = params.sessionId
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Reading** the ' } })
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'request.' } })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Mode ' + mode + '. ' } })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Tools from ' + servers.map(server => server.name + '@' + server.env[0].value).join(',') + '.' } })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: process.env.TOOL_TITLE || 'Edit worker.ts', kind: process.env.TOOL_KIND || 'edit', status: 'pending', locations: [{ path: 'src/worker.ts' }], rawInput: { command: 'npm install' } })
    const answer = await new Promise(resolve => {
      waiting.set(77, resolve)
      send({ id: 77, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-1', rawInput: { command: 'npm install' } }, options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ] } })
    })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Permission ' + answer.outcome.optionId + ' for: ' + params.prompt[0].text } })
    return send({ id, result: { stopReason: process.env.STOP_REASON || 'end_turn' } })
  }
  send({ id, error: { code: -32601, message: 'unknown' } })
})
lines.on('close', () => process.exit(0))
`

function turn(root, overrides = {}) {
  const script = path.join(root, 'agent.cjs')
  if (!fs.existsSync(script)) fs.writeFileSync(script, AGENT)
  return {
    workspaceId: 'ws', messageId: 'turn', hostId: 'devin-cli', rootPath: root, revision: 'initial', prompt: 'Claim work order x',
    launcher: { command: process.execPath, args: [] }, args: [script], threadId: 'thread', mode: 'build',
    driver: agentDriver('devin-cli'),
    acp: { mcpServers: [{ name: 'ambio', command: 'archd', args: ['mcp-run'], env: [{ name: 'AMBIO_WORKSPACE_ID', value: 'ws' }] }] },
    ...overrides,
  }
}

test('a turn\'s mode decides what an ACP agent may do and which of its own modes it runs in', () => {
  const options = [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }]
  // Changing the project's files is a build's alone.
  for (const kind of ['edit', 'delete', 'move']) {
    assert.equal(acpPermission('build', kind, options), 'yes')
    assert.equal(acpPermission('ask', kind, options), 'no')
    assert.equal(acpPermission('propose', kind, options), 'no')
  }
  // Running commands, looking, and talking to Ambio are allowed in every mode.
  for (const kind of ['execute', 'read', 'search', 'fetch', 'think', 'other', undefined]) {
    assert.equal(acpPermission('ask', kind, options), 'yes')
    assert.equal(acpPermission('build', kind, options), 'yes')
  }
  // With no fitting answer offered, the request is cancelled, never guessed.
  assert.equal(acpPermission('ask', 'edit', [{ optionId: 'yes', kind: 'allow_once' }]), undefined)
  assert.equal(acpPermission('build', 'edit', [{ optionId: 'always', kind: 'allow_always' }]), 'always')

  const modes = [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }]
  assert.equal(acpModeFor('ask', modes), 'ask')
  assert.equal(acpModeFor('propose', modes), 'plan')
  assert.equal(acpModeFor('build', modes), 'agent')
  assert.equal(acpModeFor('propose', [{ id: 'architect', name: 'Architect' }, { id: 'code', name: 'Code' }]), 'architect')
  assert.equal(acpModeFor('ask', [{ id: 'code', name: 'Code' }]), undefined)
})

test('an ACP turn hands the agent Ambio\'s tools, records what it does and remembers its session', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const started = await runner.start(turn(root))
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'completed', run.detail)
  assert.equal(run.sessionId, 'fresh-session')
  assert.equal(runner.session('ws', 'thread', 'devin-cli'), 'fresh-session')
  assert.deepEqual(runner.events('ws', run.key).map(event => [event.kind, event.text]), [
    // What it thought arrives in pieces and is said once, before what it said.
    ['thinking', 'Reading the request.'],
    ['text', 'Mode agent. Tools from ambio@ws.'],
    ['tool', 'Edit worker.ts · src/worker.ts'],
    ['text', 'Permission yes for: Claim work order x'],
  ])
})

test('a question in an ACP agent runs in its ask mode and is refused when it tries to edit', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const started = await runner.start(turn(root, { mode: 'ask' }))
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'completed', run.detail)
  const events = runner.events('ws', run.key).filter(event => event.kind !== 'thinking').map(event => event.text)
  assert.equal(events[0], 'Mode ask. Tools from ambio@ws.')
  assert.ok(events.some(text => /^Refused · Edit worker\.ts/.test(text)), events.join(' | '))
  assert.equal(events.at(-1), 'Permission no for: Claim work order x')
})

test('an ACP turn continues the earlier session without repeating it, and starts a new one when it is gone', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const base = turn(root)
  const continued = await settled(runner, 'ws', (await runner.start({ ...base, messageId: 'turn-2', sessionId: 'known', resumed: true, acp: { ...base.acp, resume: 'known' } })).key)
  assert.equal(continued.state, 'completed', continued.detail)
  assert.equal(continued.resumed, true)
  assert.equal(continued.sessionId, 'known')
  // What the session said before is its history, not this turn.
  assert.ok(!runner.events('ws', continued.key).some(event => /LAST TIME/.test(event.text)))

  const restarted = await settled(runner, 'ws', (await runner.start({ ...base, messageId: 'turn-3', sessionId: 'gone', resumed: true, acp: { ...base.acp, resume: 'gone' } })).key)
  assert.equal(restarted.state, 'completed', restarted.detail)
  assert.equal(restarted.resumed, false)
  assert.equal(restarted.sessionId, 'fresh-session')
  assert.equal(runner.session('ws', 'thread', 'devin-cli'), 'fresh-session')
})

test('an ACP agent that cannot start or stops early is a failed run that says why', async t => {
  const root = fixture(t)
  const authSpawn = (command, args, options) => testSpawn(command, args, { ...options, env: { ...options.env, FAIL_NEW: '1' } })
  const runner = new DeliveryRunner(path.join(root, 'runs'), authSpawn)
  const refused = await settled(runner, 'ws', (await runner.start(turn(root))).key)
  assert.equal(refused.state, 'failed')
  assert.match(refused.detail, /Authentication required.*Sign in to this agent/)
  assert.equal(runner.events('ws', refused.key).at(-1).kind, 'error')

  const earlySpawn = (command, args, options) => testSpawn(command, args, { ...options, env: { ...options.env, STOP_REASON: 'max_tokens' } })
  const second = new DeliveryRunner(path.join(root, 'runs-2'), earlySpawn)
  const early = await settled(second, 'ws', (await second.start(turn(root))).key)
  assert.equal(early.state, 'failed')
  assert.match(early.detail, /stopped early \(max_tokens\)/)
})

test('an ACP agent is allowed to run commands without anyone being asked, in a build and in a question', async t => {
  const root = fixture(t)
  const shell = (command, args, options) => testSpawn(command, args, { ...options, env: { ...options.env, TOOL_KIND: 'execute', TOOL_TITLE: 'Run npm install' } })
  for (const mode of ['build', 'ask']) {
    const runner = new DeliveryRunner(path.join(root, `runs-${mode}`), shell)
    const run = await settled(runner, 'ws', (await runner.start(turn(root, { mode }))).key)
    assert.equal(run.state, 'completed', run.detail)
    const events = runner.events('ws', run.key).map(event => event.text)
    assert.equal(events.at(-1), 'Permission yes for: Claim work order x', mode)
    assert.ok(!events.some(text => /^Refused|^Not allowed/.test(text)), events.join(' | '))
  }
})

test('a host that cannot hold an ACP session runs the same turn in print mode', async t => {
  const root = fixture(t)
  const old = (command, args, options) => testSpawn(command, args, { ...options, env: { ...options.env, NO_ACP: '1' } })
  const runner = new DeliveryRunner(path.join(root, 'runs'), old)
  const print = ['-e', 'console.log("Answered in print mode.")']
  const base = turn(root, { hostId: 'copilot-cli', driver: agentDriver('copilot-cli') })
  const run = await settled(runner, 'ws', (await runner.start({ ...base, fresh: () => ({ args: print }) })).key)
  assert.equal(run.state, 'completed', run.detail)
  assert.deepEqual(runner.events('ws', run.key).map(event => event.text), ['Answered in print mode.'])
  assert.match(fs.readFileSync(run.logPath, 'utf8'), /running this turn in print mode/)
})

test('supported ACP agents remain listed independently of editor discovery and report their CLI availability', t => {
  const root = fixture(t)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const env = { PATH: bin }
  for (const name of ['devin']) fs.writeFileSync(path.join(bin, process.platform === 'win32' ? `${name}.exe` : name), '', { mode: 0o755 })
  // Google's ACP server for Antigravity ships as a .par on every platform.
  fs.writeFileSync(path.join(bin, 'agy_acp_server.par'), '', { mode: 0o755 })
  const ids = hosts => deliveryTargets(hosts, env, process.platform, root).map(target => target.id)
  assert.ok(ids([{ id: 'codex', label: 'Codex' }]).includes('devin-cli'))
  assert.ok(ids([{ id: 'windsurf', label: 'Windsurf' }]).includes('devin-cli'))
  // Gemini CLI is no longer offered: Google moved it into Antigravity.
  assert.ok(!ids([{ id: 'antigravity', label: 'Antigravity' }]).includes('gemini-cli'))
  assert.ok(ids([{ id: 'antigravity', label: 'Antigravity' }]).includes('antigravity-acp'))
  assert.equal(deliveryTargets([{ id: 'windsurf', label: 'Windsurf' }], env, process.platform, root).find(target => target.id === 'antigravity-acp').available, true)
  assert.equal(agentDriver('devin-cli').acp, true)
  assert.equal(agentDriver('gemini-cli'), undefined)
  assert.deepEqual(agentDriver('devin-cli').plan({}).args, ['acp'])
})
