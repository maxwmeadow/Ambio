import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DeliveryRunner, deliveryTargets } from './agentDelivery.ts'
import { AcpClient, acpModeFor, acpPermission, acpToolDetail, acpUsage, unifiedDiff } from './acpClient.ts'
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
    // The title already names the file: it is said once.
    ['tool', 'Edit worker.ts'],
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
  // Google's CLI now includes its own ACP server.
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), '', { mode: 0o755 })
  const ids = hosts => deliveryTargets(hosts, env, process.platform, root).map(target => target.id)
  assert.ok(ids([{ id: 'codex', label: 'Codex' }]).includes('devin-cli'))
  assert.ok(ids([{ id: 'windsurf', label: 'Windsurf' }]).includes('devin-cli'))
  // Gemini CLI is no longer offered: Google moved it into Antigravity.
  assert.ok(!ids([{ id: 'antigravity', label: 'Antigravity' }]).includes('gemini-cli'))
  // Antigravity's ACP server is a connection of Antigravity CLI, not a client of its own.
  assert.ok(!ids([{ id: 'antigravity', label: 'Antigravity' }]).includes('antigravity-acp'))
  assert.equal(deliveryTargets([{ id: 'windsurf', label: 'Windsurf' }], env, process.platform, root).find(target => target.id === 'antigravity-cli').available, true)
  assert.equal(agentDriver('devin-cli').acp, true)
  assert.equal(agentDriver('gemini-cli'), undefined)
  assert.equal(agentDriver('antigravity-acp'), undefined)
  assert.deepEqual(agentDriver('devin-cli').plan({}).args, ['acp'])
  assert.deepEqual(agentDriver('antigravity-cli', 'acp').plan({}).args, ['acp'])
})

// A peer that answers the handshake, then plays `script` while the prompt waits.
function scriptedClient(script, extra = {}) {
  const events = [], usages = []
  let client
  const reply = (id, result) => setImmediate(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id, result })))
  client = new AcpClient({
    cwd: '/project', prompt: 'Go', mode: 'build', mcpServers: [], onSession: () => {},
    onEvent: event => events.push(event), onUsage: usage => usages.push(usage), ...extra,
    send: line => {
      const message = JSON.parse(line)
      if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: {} })
      else if (message.method === 'session/new') reply(message.id, { sessionId: 's' })
      else if (message.method === 'session/prompt') setImmediate(async () => {
        for (const step of script) {
          if (typeof step === 'number') await new Promise(resolve => setTimeout(resolve, step))
          else client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: step } }))
        }
        client.receive(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, thoughtTokens: 3, totalTokens: 107 } } }))
      })
    },
  })
  return { client, events, usages }
}

test('an ACP agent\'s message is one growing item, replaced by the whole message', async () => {
  const chunk = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const { client, events } = scriptedClient([chunk('Hello '), 300, chunk('there.')])
  await client.run()
  const texts = events.filter(event => event.kind === 'text')
  assert.ok(texts.length >= 2, JSON.stringify(texts))
  assert.ok(texts.every(event => event.id === texts[0].id && /^live:/.test(event.id)))
  assert.deepEqual(texts.slice(0, -1).map(event => event.live), texts.slice(0, -1).map(() => true))
  assert.deepEqual(texts.at(-1), { id: texts[0].id, kind: 'text', text: 'Hello there.' })
})

test('an ACP tool call and its updates are one item with its output, diff and exit status', async () => {
  const { client, events, usages } = scriptedClient([
    { sessionUpdate: 'tool_call', toolCallId: 'run', title: 'npm test', kind: 'execute', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'run', title: 'npm test', status: 'completed', rawOutput: { exit_code: 1 }, content: [{ type: 'content', content: { type: 'text', text: '1 failing' } }] },
    { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'File a.txt', kind: 'edit', status: 'in_progress', locations: [{ path: 'a.txt' }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'edit', title: 'File /C:/project/a.txt', status: 'completed', content: [{ type: 'diff', path: 'a.txt', oldText: 'one\ntwo\n', newText: 'one\n2\n' }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' },
  ])
  await client.run()
  const run = events.filter(event => event.id === 'run'), edit = events.filter(event => event.id === 'edit')
  assert.deepEqual(run.at(-1), { id: 'run', kind: 'tool', text: 'Run · npm test', status: 'completed', output: '1 failing', exitCode: 1 })
  // A later update without content keeps the diff, and the label the call started with.
  assert.equal(edit.at(-1).text, 'Edit · a.txt')
  assert.equal(edit.at(-1).diff, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2')
  assert.ok(!events.some(event => 'content' in event || 'toolCallId' in event))
  assert.deepEqual(usages.at(-1), { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 107 })
})

test('a unified diff names a new file and keeps three lines of context', () => {
  assert.equal(unifiedDiff('n.txt', null, 'hi\n'), '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hi')
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'), after = before.replace('e', 'E')
  assert.equal(unifiedDiff('f', before, after), '--- a/f\n+++ b/f\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h')
  assert.deepEqual(acpToolDetail(undefined), {})
  assert.equal(acpUsage({ outputTokens: 3 }), undefined)
})

test('Antigravity\'s ACP connection offers Ask me and Full access, its print route none', () => {
  assert.deepEqual(agentDriver('antigravity-cli', 'acp').access, ['ask', 'full'])
  assert.equal(agentDriver('antigravity-cli').access, undefined)
  assert.equal(agentDriver('antigravity-cli', 'print').access, undefined)
})

test('an ACP tool call is labelled once, with its verb and the file from home', async () => {
  const { acpToolLabel, homeShortened } = await import('./acpClient.ts')
  const home = 'C:\\Users\\max'
  // agy: "File <relative>" plus the same file as an absolute location.
  assert.equal(acpToolLabel('File ../../.gemini/config/skills/ambio-inbox/SKILL.md', 'read', 'C:\\Users\\max\\.gemini\\config\\skills\\ambio-inbox\\SKILL.md', home),
    'Read \u00b7 ~/.gemini/config/skills/ambio-inbox/SKILL.md')
  // agy titles an edit the same way; its kind says it is one.
  assert.equal(acpToolLabel('File a.txt', 'edit', 'a.txt', home), 'Edit · a.txt')
  // A title that already names the file keeps no second copy of it.
  assert.equal(acpToolLabel('Edit src/app.ts', 'edit', 'C:\\work\\src\\app.ts', home), 'Edit src/app.ts')
  // A kind adds its verb when the title has none; MCP titles are left to the view.
  assert.equal(acpToolLabel('npm test', 'execute', undefined, home), 'Run \u00b7 npm test')
  assert.equal(acpToolLabel('Run mcp_ambio_get_inbox', 'execute', undefined, home), 'Run mcp_ambio_get_inbox')
  assert.equal(homeShortened('/home/max/notes.md', '/home/max'), '~/notes.md')
  // Inside the project, a path is written from the project.
  assert.equal(homeShortened('/home/max/work/app/src/a.ts', '/home/max', '/home/max/work/app'), 'src/a.ts')
  assert.equal(acpToolLabel('File notes/missing.md', 'read', '/home/max/work/app/notes/missing.md', '/home/max', '/home/max/work/app'), 'Read · notes/missing.md')
})
