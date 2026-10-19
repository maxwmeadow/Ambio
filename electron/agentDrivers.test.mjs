import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DeliveryRunner, chatDeepLink, deliveryPlan, deliveryTargets, findDeliveryCli } from './agentDelivery.ts'
import { agentDriver, turnMode } from './agentDrivers.ts'

const mcp = { command: 'C:\\Ambio Install\\archd.exe', args: ['mcp-run', 'runtime', 'entry'] }
const HOSTS = ['claude-code', 'codex', 'copilot-cli', 'cursor-cli', 'antigravity-cli']

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-drivers-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function testSpawn(command, args, options) {
  const env = { ...options.env }
  delete env.NODE_TEST_CONTEXT
  return spawn(command, args, { ...options, env })
}
async function settled(runner, workspace, key) {
  for (let i = 0; i < 400; i++) {
    const run = runner.list(workspace).find(item => item.key === key)
    if (run && ['completed', 'failed', 'stopped', 'launch-failed'].includes(run.state)) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`run did not settle: ${JSON.stringify(runner.list(workspace))}`)
}

test('agents Ambio runs get every permission they offer; a question or a proposal loses only file editing', () => {
  for (const host of HOSTS) {
    for (const mode of ['ask', 'propose']) {
      const args = deliveryPlan(host, mcp, 'ws', 'Claim work order x', { mode }).args
      if (host === 'claude-code') {
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions')
        assert.match(args[args.indexOf('--disallowedTools') + 1], /Edit,Write/)
        assert.ok(!args.includes('--allowedTools'))
      }
      // Commands run; the sandbox stops writes.
      if (host === 'codex') assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
      if (host === 'copilot-cli') {
        assert.ok(args.includes('--allow-all-tools') && !args.includes('--yolo'))
        assert.equal(args[args.indexOf('--deny-tool') + 1], 'write')
      }
      if (host === 'cursor-cli') assert.equal(args[args.indexOf('--mode') + 1], mode === 'ask' ? 'ask' : 'plan')
      if (host === 'antigravity-cli') assert.ok(args.includes('--dangerously-skip-permissions'))
    }
    const build = deliveryPlan(host, mcp, 'ws', 'Claim work order x', { mode: 'build' }).args
    if (host === 'claude-code') {
      assert.equal(build[build.indexOf('--permission-mode') + 1], 'bypassPermissions')
      assert.ok(!build.includes('--disallowedTools') && !build.includes('--permission-prompt-tool'))
    }
    if (host === 'codex') assert.equal(build[build.indexOf('--sandbox') + 1], 'danger-full-access')
    if (host === 'copilot-cli') assert.ok(build.includes('--yolo') && !build.includes('--deny-tool'))
    if (host === 'cursor-cli') assert.ok(build.includes('--force'))
    if (host === 'antigravity-cli') assert.ok(build.includes('--dangerously-skip-permissions'))
  }
  // A continued Codex session is given the same sandbox.
  const resumed = deliveryPlan('codex', mcp, 'ws', 'p', { mode: 'build', resume: 'thread-1' }).args
  assert.ok(resumed.includes('sandbox_mode="danger-full-access"'))
  assert.equal(turnMode('ask'), 'ask')
  assert.equal(turnMode(''), 'build')
  assert.equal(turnMode(undefined), 'build')
})

test('every destination the picker can show explains how to use it', async () => {
  const { DESTINATION_GUIDE } = await import('../src/shared/agentDelivery.ts')
  const { buildHosts } = await import('./agentInstallers.ts')
  for (const id of [...buildHosts().map(host => host.id), 'cursor-cli', 'devin-cli', 'antigravity-acp', 'antigravity-cli', '@watching', '']) {
    assert.ok(DESTINATION_GUIDE[id]?.how.length && DESTINATION_GUIDE[id].can.length && DESTINATION_GUIDE[id].need.length, `no guide for ${id || 'manual'}`)
  }
})

test('readiness is said in each kind of agent’s own terms', async () => {
  const { deliveryReadiness, WATCHING_DELIVERY } = await import('../src/shared/agentDelivery.ts')
  const hosts = [
    { id: 'claude-code', label: 'Claude Code', route: 'run', available: true, detail: '' },
    { id: 'codex', label: 'Codex', route: 'run', available: false, detail: '' },
    { id: 'copilot', label: 'VS Code', route: 'open', available: true, detail: '' },
  ]
  const ready = (hostId, extra = {}) => deliveryReadiness({ hostId, hosts, installedIds: [], watchers: 0, watchingHosts: [], ...extra })
  // A started agent needs nothing open, and no MCP connection, to be ready.
  assert.equal(ready('claude-code').tone, 'ready')
  assert.deepEqual([ready('codex').tone, ready('codex').fix], ['blocked', 'agents'])
  // An agent in another app needs Ambio added, then reads as ready once attached.
  assert.equal(ready('copilot').tone, 'blocked')
  assert.equal(ready('copilot', { installedIds: ['copilot'] }).tone, 'attention')
  assert.equal(ready('copilot', { installedIds: ['copilot'], watchingHosts: ['copilot'] }).tone, 'ready')
  assert.equal(ready(WATCHING_DELIVERY).tone, 'attention')
  assert.equal(ready(WATCHING_DELIVERY, { watchers: 2 }).tone, 'ready')
  assert.equal(ready('', { chat: { service: 'OpenAI', keyMissing: false } }).tone, 'ready')
  assert.equal(ready('', { chat: { service: 'OpenAI', keyMissing: true } }).fix, 'agents')
  for (const result of [ready('claude-code'), ready('copilot'), ready('', { chat: { service: 'OpenAI', keyMissing: false } })]) assert.doesNotMatch(result.text, /MCP/)
})

test('a later turn continues the host session where the host can, and names a new one where it lets Ambio', () => {
  const first = deliveryPlan('claude-code', mcp, 'ws', 'p')
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/)
  assert.equal(first.args[first.args.indexOf('--session-id') + 1], first.sessionId)
  assert.equal(first.stdin, 'p')
  const next = deliveryPlan('claude-code', mcp, 'ws', 'p', { resume: 'session-1' })
  assert.equal(next.args[next.args.indexOf('--resume') + 1], 'session-1')
  assert.ok(!next.args.includes('--session-id'))

  const codex = deliveryPlan('codex', mcp, 'ws', 'p', { resume: 'thread-9', mode: 'ask' }).args
  assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', 'thread-9'])
  // resume takes no --sandbox; the same sandbox goes in as configuration.
  assert.ok(!codex.includes('--sandbox'))
  assert.ok(codex.includes('sandbox_mode="read-only"'))
  assert.equal(codex.at(-1), '-')
  assert.ok(deliveryPlan('cursor-cli', mcp, 'ws', 'p', { resume: 'chat-3' }).args.includes('--resume=chat-3'))

  // Copilot's print mode reports no session; its ACP server keeps one, so
  // that is how a turn is started, with print mode behind it.
  const acp = agentDriver('copilot-cli').acpArgs({ hostId: 'copilot-cli', mcp, workspaceId: 'ws', prompt: 'p', mode: 'build', messageId: 'turn-1' })
  assert.equal(acp[0], '--acp')
  // Its ACP server ignores MCP servers named in session/new, so Ambio's goes on the command line.
  const config = JSON.parse(acp[acp.indexOf('--additional-mcp-config') + 1])
  assert.equal(config.mcpServers.ambio.env.AMBIO_WORKSPACE_ID, 'ws')
  assert.equal(config.mcpServers.ambio.env.AMBIO_RUN_MESSAGE_ID, 'turn-1')
  assert.equal(agentDriver('copilot-cli').resumable, true)
  assert.equal(deliveryPlan('copilot-cli', mcp, 'ws', 'p').stdin, undefined)
  assert.throws(() => deliveryPlan('cursor', mcp, 'ws', 'p'), /no direct/)
})

test('a started turn still names its request to Ambio, and Cursor accepts its workspace itself', () => {
  const build = deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'build', messageId: 'turn-7' }).args
  assert.equal(JSON.parse(build[build.indexOf('--mcp-config') + 1]).mcpServers.ambio.env.AMBIO_RUN_MESSAGE_ID, 'turn-7')
  // Nothing is asked: every permission is already granted.
  assert.ok(!build.includes('--permission-prompt-tool'))
  // Cursor's headless run accepts the workspace and Ambio's MCP server itself.
  const cursor = deliveryPlan('cursor-cli', mcp, 'ws', 'p', { mode: 'ask' }).args
  assert.ok(cursor.includes('--trust') && cursor.includes('--approve-mcps'))
})

test('each host\'s output is read for its session and for what the agent is doing', () => {
  const claude = agentDriver('claude-code')
  assert.deepEqual(claude.read(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })), { sessionId: 's1', events: [] })
  assert.deepEqual(claude.read(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [
    { type: 'text', text: 'Reading the worker.' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'src/worker.ts' } },
    { type: 'tool_use', name: 'mcp__ambio__reply_to_canvas', input: {} },
  ] } })).events, [
    { kind: 'text', text: 'Reading the worker.' },
    { kind: 'tool', text: 'Read · src/worker.ts' },
    { kind: 'tool', text: 'Ambio · reply_to_canvas' },
  ])
  assert.deepEqual(claude.read(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'sub', message: { content: [{ type: 'text', text: 'subagent' }] } })).events, [])
  assert.equal(claude.read(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })).events[0].kind, 'error')
  assert.deepEqual(claude.read('not json').events, [])

  const codex = agentDriver('codex')
  assert.equal(codex.read(JSON.stringify({ type: 'thread.started', thread_id: 't1' })).sessionId, 't1')
  assert.deepEqual(codex.read(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })).events, [{ kind: 'text', text: 'Done.' }])
  assert.deepEqual(codex.read(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'go test ./...' } })).events, [{ kind: 'tool', text: 'Shell · go test ./...' }])
  assert.deepEqual(codex.read(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'ambio', tool: 'get_inbox' } })).events, [{ kind: 'tool', text: 'Ambio · get_inbox' }])
  assert.equal(codex.read(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } })).events[0].text, 'quota')

  assert.deepEqual(agentDriver('copilot-cli').read('Working on it').events, [{ kind: 'text', text: 'Working on it' }])
  const cursor = agentDriver('cursor-cli')
  assert.deepEqual(cursor.read(JSON.stringify({ type: 'tool_call', subtype: 'started', session_id: 'c1', tool_call: { readToolCall: { args: { path: 'a.ts' } } } })),
    { sessionId: 'c1', events: [{ kind: 'tool', text: 'read · a.ts' }] })
})

test('VS Code and Cursor are opened with the handoff in their chat; other editors have no such link', () => {
  const prompt = 'Check Ambio work order 42 for "Shop & Co" (C:\\shop). Call get_inbox #1 + more'
  const code = chatDeepLink('copilot', prompt, 'ask')
  assert.ok(code.startsWith('vscode://GitHub.Copilot-Chat/chat?mode=ask&prompt='))
  assert.equal(decodeURIComponent(code.split('prompt=')[1]), prompt)
  assert.ok(chatDeepLink('copilot', prompt, 'build').includes('mode=agent'))
  const cursor = chatDeepLink('cursor', prompt)
  assert.ok(cursor.startsWith('cursor://anysphere.cursor-deeplink/prompt?text='))
  // Cursor cuts a link at a raw "&" and turns "+" into a space; neither survives unencoded.
  assert.ok(!/[&+ #]/.test(cursor.split('text=')[1]))
  assert.equal(decodeURIComponent(cursor.split('text=')[1]), prompt)
  // Past Cursor's limit the clipboard is used instead of a link it would reject.
  assert.equal(chatDeepLink('cursor', 'x'.repeat(9000)), undefined)
  for (const host of ['windsurf', 'zed', 'jetbrains', 'claude-desktop', 'antigravity']) assert.equal(chatDeepLink(host, prompt), undefined)
})

test('Antigravity\'s own CLI runs in print mode with every permission granted, and continues its conversation', t => {
  const driver = agentDriver('antigravity-cli')
  const first = driver.plan({ hostId: 'antigravity-cli', mode: 'build', mcp, workspaceId: 'ws', prompt: 'Claim work order x' })
  // Its print mode cannot ask, so every permission is granted up front.
  assert.deepEqual(first.args, ['-p', 'Claim work order x', '--output-format', 'stream-json', '--dangerously-skip-permissions'])
  assert.equal(driver.resumable, true)
  assert.equal(first.stdin, undefined)
  const next = driver.plan({ hostId: 'antigravity-cli', mode: 'ask', mcp, workspaceId: 'ws', prompt: 'p', resume: 'conv-1' })
  assert.deepEqual(next.args.slice(-2), ['--conversation', 'conv-1'])
  assert.ok(next.args.includes('--dangerously-skip-permissions'))
  assert.equal(driver.read(JSON.stringify({ type: 'init', conversation_id: 'conv-1' })).sessionId, 'conv-1')
  assert.deepEqual(driver.read(JSON.stringify({ type: 'step_update', step: { type: 'tool', status: 'started', tool: { name: 'read_file', args: { path: 'a.ts' } } } })).events, [{ kind: 'tool', text: 'read_file · a.ts' }])
  assert.deepEqual(driver.read(JSON.stringify({ type: 'step_update', step: { type: 'agent_response', text: 'Done.' } })).events, [{ kind: 'text', text: 'Done.' }])
  assert.deepEqual(driver.read(JSON.stringify({ type: 'step_update', step: { type: 'agent_response', delta: 'Do' } })).events, [])
  assert.equal(driver.read(JSON.stringify({ type: 'result', status: 'ERROR', error: 'authentication required' })).events[0].kind, 'error')
  assert.deepEqual(driver.read(JSON.stringify({ type: 'result', status: 'SUCCESS' })).events, [])

  const root = fixture(t)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), '', { mode: 0o755 })
  const offered = deliveryTargets([{ id: 'antigravity', label: 'Antigravity' }], { PATH: bin }, process.platform, root).find(target => target.id === 'antigravity-cli')
  assert.equal(offered?.route, 'run')
  assert.match(offered.detail, /started by Ambio/); assert.doesNotMatch(offered.detail, /Experimental/)
})

test('Antigravity 1.4 reports each step as it happens: tools when they start, text when it is done', () => {
  const driver = agentDriver('antigravity-cli')
  // Lines as agy 1.4.2 printed them.
  const conversation = '1c5cd41f-9b8f-46db-bbba-f1aa1f697898'
  const line = (event, payload) => JSON.stringify({ event, [event]: { conversation_id: conversation, ...payload } })
  assert.equal(driver.read(line('init', { cwd: 'C:\\proj' })).sessionId, conversation)
  assert.deepEqual(driver.read(line('step_update', { step_index: 0, state: 'DONE', step_type: 'user_input' })).events, [])
  assert.deepEqual(driver.read(line('step_update', { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'Get-ChildItem' } } })).events,
    [{ kind: 'tool', text: 'run_command · Get-ChildItem' }])
  assert.deepEqual(driver.read(line('step_update', { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command' })).events, [])
  assert.deepEqual(driver.read(line('step_update', { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Files in the current dir' })).events, [])
  assert.deepEqual(driver.read(line('step_update', { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ectory.' })).events, [])
  assert.deepEqual(driver.read(line('step_update', { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n' })).events,
    [{ kind: 'text', text: 'Files in the current directory.' }])
  // A step of a kind Ambio does not know is still said, so a long wait is never silent.
  assert.deepEqual(driver.read(line('step_update', { step_index: 4, state: 'ACTIVE', step_type: 'background_task' })).events, [{ kind: 'tool', text: 'background task' }])
  assert.equal(driver.read(line('result', { status: 'ERROR', error: 'quota exceeded' })).events[0].text, 'quota exceeded')
  assert.deepEqual(driver.read(line('result', { status: 'SUCCESS', response: 'done' })).events, [])
  // An agy too old for stream-json says how to fix it.
  assert.match(driver.read('flag provided but not defined: -output-format').events[0].text, /agy update/)
})

test('a host that exits cleanly after being stopped from using Ambio is a failed turn that says how to fix it', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const driver = agentDriver('antigravity-cli')
  // What agy 1.0.16 prints, on its error output, before exiting 0.
  const refusal = 'jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.'
  const started = await runner.start({
    workspaceId: 'ws', messageId: 'turn-agy', hostId: 'antigravity-cli', rootPath: root, revision: 'initial', prompt: 'p',
    launcher: { command: process.execPath, args: [] }, args: ['-e', `console.error(${JSON.stringify(refusal)})`], stdin: undefined,
    threadId: 'thread', mode: 'ask', driver,
  })
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'failed')
  assert.match(run.detail, /could not do this turn/)
  const [event] = runner.events('ws', run.key)
  assert.equal(event.kind, 'error')
  assert.match(event.text, /mcp\(ambio\/\*\).*permissions\.allow/)
  // Any other refusal ends the run too, and says which permission it was.
  assert.match(driver.readError('a tool required the "command" permission that headless mode cannot prompt for').events[0].text, /"command" permission/)
  // The project folder is named as the workspace, or its MCP config is never loaded.
  assert.deepEqual(deliveryPlan('antigravity-cli', mcp, 'ws', 'p', { cwd: '/proj' }).args, ['-p', 'p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--add-dir', '/proj'])
})

test('an npm-installed CLI is found by the entry its package declares, or the one it used to have', t => {
  const root = fixture(t)
  const npm = path.join(root, 'AppData', 'Roaming', 'npm', 'node_modules')
  // Copilot CLI 1.0.98 declares npm-loader.js, not the index.js it once had.
  const copilot = path.join(npm, '@github', 'copilot')
  fs.mkdirSync(copilot, { recursive: true })
  fs.writeFileSync(path.join(copilot, 'package.json'), JSON.stringify({ bin: { copilot: 'npm-loader.js' } }))
  fs.writeFileSync(path.join(copilot, 'npm-loader.js'), '')
  const env = { PATH: '', APPDATA: path.join(root, 'AppData', 'Roaming') }
  assert.deepEqual(findDeliveryCli('copilot-cli', env, 'win32', root, 'node.exe'), { command: 'node.exe', args: [path.join(copilot, 'npm-loader.js')], bundledNode: true })
  // A package without a manifest is still found at its old entry.
  const codex = path.join(npm, '@openai', 'codex', 'bin')
  fs.mkdirSync(codex, { recursive: true })
  fs.writeFileSync(path.join(codex, 'codex.js'), '')
  assert.deepEqual(findDeliveryCli('codex', env, 'win32', root, 'node.exe').args, [path.join(codex, 'codex.js')])
})

test('Cursor\'s terminal agent is offered only when Cursor is set up and the agent is installed', t => {
  const root = fixture(t)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const env = { PATH: bin }
  const hosts = [{ id: 'cursor', label: 'Cursor' }, { id: 'codex', label: 'Codex' }]
  assert.ok(!deliveryTargets(hosts, env, process.platform, root).some(target => target.id === 'cursor-cli'))
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent'), '', { mode: 0o755 })
  const offered = deliveryTargets(hosts, env, process.platform, root).find(target => target.id === 'cursor-cli')
  assert.equal(offered?.route, 'run')
  assert.match(offered.detail, /started by Ambio/); assert.doesNotMatch(offered.detail, /Experimental/)
  assert.ok(!deliveryTargets([{ id: 'codex', label: 'Codex' }], env, process.platform, root).some(target => target.id === 'cursor-cli'))
})

// A stand-in for a host CLI: prints the lines it is given, one a line, and
// exits with the given code.
const speak = (lines, code = 0) => ['-e', `for (const line of ${JSON.stringify(lines)}) console.log(line); process.exit(${code})`]

test('a run records what the agent said and did, and remembers its session for the next turn', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const driver = agentDriver('claude-code')
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'host-session' }),
    JSON.stringify({ type: 'assistant', session_id: 'host-session', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'retry' } }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'ok' }),
  ]
  const started = await runner.start({
    workspaceId: 'ws', messageId: 'turn-1', hostId: 'claude-code', rootPath: root, revision: 'initial', prompt: 'p',
    launcher: { command: process.execPath, args: [] }, args: speak(lines), stdin: 'p',
    threadId: 'thread', mode: 'ask', driver, sessionId: 'named-by-ambio',
  })
  // The session Ambio named is usable before the host has said anything.
  assert.equal(runner.session('ws', 'thread', 'claude-code') !== undefined, true)
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'completed')
  assert.equal(run.mode, 'ask')
  assert.equal(run.sessionId, 'host-session')
  assert.equal(runner.session('ws', 'thread', 'claude-code'), 'host-session')
  assert.equal(runner.session('ws', 'another-thread', 'claude-code'), undefined)
  assert.equal(runner.session('ws', 'thread', 'codex'), undefined)
  assert.deepEqual(runner.events('ws', run.key).map(event => [event.kind, event.text]), [['text', 'Looking.'], ['tool', 'Grep · retry']])
  assert.deepEqual(runner.events('ws', run.key, 1).map(event => event.text), ['Grep · retry'])
  // Another project cannot read this run's activity.
  assert.deepEqual(runner.events('other', run.key), [])
  assert.deepEqual(runner.events('ws', '../escape'), [])
})

test('a session that cannot be continued starts the same turn fresh instead of failing it', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const driver = agentDriver('codex')
  let freshStarts = 0
  const started = await runner.start({
    workspaceId: 'ws', messageId: 'turn-2', hostId: 'codex', rootPath: root, revision: 'initial', prompt: 'p',
    launcher: { command: process.execPath, args: [] },
    // The continued session is refused: the host reports an error and exits.
    args: speak([JSON.stringify({ type: 'error', message: 'no such session' })], 1), stdin: 'p', threadId: 'thread', mode: 'build', driver, sessionId: 'gone', resumed: true,
    fresh: () => {
      freshStarts++
      return { args: speak([JSON.stringify({ type: 'thread.started', thread_id: 'new-thread' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Built.' } })]), stdin: 'p' }
    },
  })
  const run = await settled(runner, 'ws', started.key)
  assert.equal(freshStarts, 1)
  assert.equal(run.state, 'completed')
  assert.equal(run.resumed, false)
  assert.equal(run.sessionId, 'new-thread')
  assert.equal(runner.session('ws', 'thread', 'codex'), 'new-thread')
  assert.deepEqual(runner.events('ws', run.key).map(event => event.text), ['Built.'])
  assert.match(fs.readFileSync(run.logPath, 'utf8'), /could not be continued/)
})

test('a continued session that fails after it has spoken is a failed run, not a silent restart', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  let freshStarts = 0
  const started = await runner.start({
    workspaceId: 'ws', messageId: 'turn-3', hostId: 'codex', rootPath: root, revision: 'initial', prompt: 'p',
    launcher: { command: process.execPath, args: [] },
    args: speak([JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Halfway.' } })], 1),
    stdin: 'p', threadId: 'thread', mode: 'build', driver: agentDriver('codex'), sessionId: 'live', resumed: true,
    fresh: () => { freshStarts++; return { args: speak([]) } },
  })
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'failed')
  assert.equal(freshStarts, 0)
})
