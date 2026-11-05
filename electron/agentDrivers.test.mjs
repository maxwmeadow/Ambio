import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DeliveryRunner, chatDeepLink, deliveryPlan, deliveryTargets, findDeliveryCli } from './agentDelivery.ts'
import { agentDriver, codexSandbox, turnMode } from './agentDrivers.ts'

const mcp = { command: 'C:\\Ambio Install\\archd.exe', args: ['mcp-run', 'runtime', 'entry'] }
const HOSTS = ['claude-code', 'codex', 'copilot-cli', 'cursor-cli', 'antigravity-cli', 'grok', 'muse']

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
      // Commands run; the sandbox stops writes where Codex can start one.
      if (host === 'codex') assert.equal(args[args.indexOf('--sandbox') + 1], codexSandbox(mode))
      if (host === 'copilot-cli') {
        assert.ok(args.includes('--allow-all-tools') && !args.includes('--yolo'))
        assert.equal(args[args.indexOf('--deny-tool') + 1], 'write')
      }
      if (host === 'cursor-cli') assert.equal(args[args.indexOf('--mode') + 1], mode === 'ask' ? 'ask' : 'plan')
      if (host === 'grok') assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
      if (host === 'muse') assert.deepEqual(args, ['serve'])
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
    if (host === 'grok') assert.equal(build[build.indexOf('--sandbox') + 1], 'off')
    if (host === 'muse') assert.deepEqual(build, ['serve'])
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
  // The prompt is the first message of a stream Claude Code keeps reading.
  assert.ok(first.args.includes('--replay-user-messages'))
  assert.equal(first.args[first.args.indexOf('--input-format') + 1], 'stream-json')
  assert.ok(first.stdin.endsWith('\n'))
  const message = JSON.parse(first.stdin)
  assert.deepEqual([message.type, message.message.content], ['user', 'p'])
  assert.match(message.uuid, /^[0-9a-f-]{36}$/)
  const next = deliveryPlan('claude-code', mcp, 'ws', 'p', { resume: 'session-1' })
  assert.equal(next.args[next.args.indexOf('--resume') + 1], 'session-1')
  assert.ok(!next.args.includes('--session-id'))

  const codex = deliveryPlan('codex', mcp, 'ws', 'p', { resume: 'thread-9', mode: 'ask' }).args
  assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', 'thread-9'])
  // resume takes no --sandbox; the same sandbox goes in as configuration.
  assert.ok(!codex.includes('--sandbox'))
  assert.ok(codex.includes(`sandbox_mode="${codexSandbox('ask')}"`))
  assert.equal(codex.at(-1), '-')
  assert.ok(deliveryPlan('cursor-cli', mcp, 'ws', 'p', { resume: 'chat-3' }).args.includes('--resume=chat-3'))

  // Copilot's print mode reports no session; its ACP server keeps one, so
  // that is how a turn is started, with print mode behind it.
  const acp = agentDriver('copilot-cli').acpArgs({ hostId: 'copilot-cli', mcp, workspaceId: 'ws', prompt: 'p', mode: 'build', messageId: 'turn-1' })
  assert.equal(acp[0], '--acp')
  // Its ACP server ignores MCP servers named in session/new, so Ambio's goes on the command line.
  const config = JSON.parse(acp[acp.indexOf('--additional-mcp-config') + 1])
  assert.equal(config.mcpServers.ambio.env.AMBIO_WORKSPACE_ID, 'ws')
  assert.equal(config.mcpServers.ambio.env.AMBIO_RUN_MESSAGE_ID, undefined)
  assert.equal(agentDriver('copilot-cli').resumable, true)
  assert.equal(deliveryPlan('copilot-cli', mcp, 'ws', 'p').stdin, undefined)
  assert.throws(() => deliveryPlan('cursor', mcp, 'ws', 'p'), /no direct/)
})

test('Claude Code tool calls become one item each, completed by their result (2.1.198 shapes)', () => {
  const claude = agentDriver('claude-code')
  const use = (block, parent = null) => claude.read(JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [block] } })).events[0]
  const result = (content, extra = {}) => claude.read(JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [content] }, ...extra })).events
  // A command: running, then its output and exit code; a failure reports "Exit code N".
  assert.deepEqual(use({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo hi && exit 3' } }),
    { id: 'claude:b1', kind: 'tool', text: 'Bash · echo hi && exit 3', status: 'inProgress' })
  assert.deepEqual(result({ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'Exit code 3\nhi' }),
    [{ id: 'claude:b1', kind: 'tool', text: 'Bash · echo hi && exit 3', status: 'failed', output: 'hi', exitCode: 3 }])
  use({ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls' } })
  assert.deepEqual(result({ type: 'tool_result', tool_use_id: 'b2', content: [{ type: 'text', text: 'a.txt' }] })[0], { id: 'claude:b2', kind: 'tool', text: 'Bash · ls', status: 'completed', output: 'a.txt', exitCode: 0 })
  // An edit shows what it means to change, then the patch Claude applied.
  assert.match(use({ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'notes.txt', old_string: 'beta', new_string: 'gamma' } }).diff, /-beta\n\+gamma/)
  const edited = result({ type: 'tool_result', tool_use_id: 'e1', content: 'The file notes.txt has been updated successfully.' },
    { tool_use_result: { filePath: 'notes.txt', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' alpha', '-beta', '+gamma'] }] } })[0]
  assert.equal(edited.status, 'completed'); assert.equal(edited.output, undefined)
  assert.equal(edited.diff, '--- notes.txt\n+++ notes.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma')
  // Reads report how they went, not the file; a refused tool is an error with its reason.
  use({ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } })
  assert.deepEqual(result({ type: 'tool_result', tool_use_id: 'r1', content: '1\tconst a = 1' })[0], { id: 'claude:r1', kind: 'tool', text: 'Read · a.ts', status: 'completed' })
  use({ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'b.ts', content: 'x' } })
  assert.deepEqual(result({ type: 'tool_result', tool_use_id: 'w1', is_error: true, content: 'Permission denied by the user' })[0],
    { id: 'claude:w1', kind: 'error', text: 'Write · b.ts', status: 'failed', output: 'Permission denied by the user' })
  // A subagent's tool is still marked as its; a result for an unknown call adds nothing.
  assert.equal(use({ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'x' } }, 'parent').text, 'Subagent · Grep · x')
  assert.deepEqual(result({ type: 'tool_result', tool_use_id: 'nobody', content: 'x' }), [])
  // The turn's usage, in the shape every agent reports: input counts cached and newly cached tokens.
  assert.deepEqual(claude.read(JSON.stringify({ type: 'result', is_error: false, result: 'Done.', usage: { input_tokens: 26, cache_creation_input_tokens: 52199, cache_read_input_tokens: 25244, output_tokens: 631 } })).usage,
    { inputTokens: 77469, cachedInputTokens: 25244, outputTokens: 631, reasoningOutputTokens: 0, totalTokens: 78100 })
})

test('Claude Code runs at the access level chosen for it, and asks in Ambio below full access', () => {
  const plan = access => deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'build', messageId: 'turn-1', access }).args
  const mode = args => args[args.indexOf('--permission-mode') + 1]
  const asks = args => args[args.indexOf('--permission-prompt-tool') + 1]
  assert.deepEqual([mode(plan('ask')), asks(plan('ask'))], ['default', 'mcp__ambio__approve_action'])
  assert.deepEqual([mode(plan('edits')), asks(plan('edits'))], ['acceptEdits', 'mcp__ambio__approve_action'])
  assert.deepEqual([mode(plan('auto')), asks(plan('auto'))], ['auto', 'mcp__ambio__approve_action'])
  // Full access asks nothing, but Claude's questions still reach the conversation through the same tool.
  for (const args of [plan('full'), plan(undefined)]) assert.deepEqual([mode(args), asks(args)], ['bypassPermissions', 'mcp__ambio__approve_action'])
  // Ambio's own tools claim and answer the turn, so they never ask.
  assert.equal(plan('ask')[plan('ask').indexOf('--allowedTools') + 1], 'mcp__ambio')
  // A question keeps its editing tools off at every level.
  const ask = deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'ask', access: 'ask' }).args
  assert.match(ask[ask.indexOf('--disallowedTools') + 1], /Edit,Write/)
  // The user's own MCP servers load beside Ambio's; a mapping turn uses only Ambio.
  assert.ok(!plan('ask').includes('--strict-mcp-config'))
  const mapping = deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'build', access: 'ask', mapping: { attempt: { id: 'a1' }, token: 't' } }).args
  assert.ok(mapping.includes('--strict-mcp-config'))
  assert.equal(mode(mapping), 'bypassPermissions')
  assert.deepEqual(agentDriver('claude-code').access, ['ask', 'edits', 'auto', 'full'])
  // Codex's App Server asks through Ambio or runs with full access.
  assert.deepEqual(agentDriver('codex').access, ['ask', 'full'])
  assert.equal(agentDriver('copilot-cli').access, undefined)
})

test('a started turn still names its request to Ambio, and Cursor accepts its workspace itself', () => {
  const build = deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'build', messageId: 'turn-7' }).args
  assert.equal(JSON.parse(build[build.indexOf('--mcp-config') + 1]).mcpServers.ambio.env.AMBIO_RUN_MESSAGE_ID, 'turn-7')
  // Every permission is already granted; only Claude's own questions go to approve_action.
  assert.equal(build[build.indexOf('--permission-mode') + 1], 'bypassPermissions')
  assert.equal(build[build.indexOf('--permission-prompt-tool') + 1], 'mcp__ambio__approve_action')
  // A mapping turn asks nothing at all.
  const mapped = deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'build', messageId: 'turn-7', mapping: { attempt: { id: 'a1' }, token: 't' } }).args
  assert.ok(!mapped.includes('--permission-prompt-tool'))
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
  // A subagent's words stay in its transcript; what it does is shown as its.
  assert.deepEqual(claude.read(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'sub', message: { content: [
    { type: 'text', text: 'subagent' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'retry' } },
  ] } })).events, [{ kind: 'tool', text: 'Subagent · Grep · retry' }])
  assert.equal(claude.read(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })).events[0].kind, 'error')
  // The result ends the turn; an echoed message is the agent taking it in.
  assert.equal(claude.read(JSON.stringify({ type: 'result', is_error: false, result: 'ok' })).ended, true)
  assert.equal(claude.read(JSON.stringify({ type: 'user', isReplay: true, uuid: 'm-1', message: { content: 'x' } })).delivered, 'm-1')
  assert.equal(claude.read(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).delivered, undefined)
  assert.deepEqual(JSON.parse(claude.stream.interrupt()).request, { subtype: 'interrupt' })
  // Text as it is written, the main agent's only.
  const delta = (text, parent = null) => JSON.stringify({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  assert.equal(claude.read(delta('Look')).partial, 'Look')
  assert.equal(claude.read(delta('sub', 'tool-1')).partial, undefined)
  assert.equal(claude.read(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } })).partial, undefined)
  assert.ok(deliveryPlan('claude-code', mcp, 'ws', 'p').args.includes('--include-partial-messages'))
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
  assert.deepEqual(first.args, ['-p', 'Claim work order x', '--output-format', 'stream-json', '--print-timeout', '24h', '--dangerously-skip-permissions'])
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
  assert.deepEqual(deliveryPlan('antigravity-cli', mcp, 'ws', 'p', { cwd: '/proj' }).args, ['-p', 'p', '--output-format', 'stream-json', '--print-timeout', '24h', '--dangerously-skip-permissions', '--add-dir', '/proj'])
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

test('Cursor CLI stays listed when missing and becomes available when installed independently of the editor', t => {
  const root = fixture(t)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const env = { PATH: bin }
  const hosts = [{ id: 'cursor', label: 'Cursor' }, { id: 'codex', label: 'Codex' }]
  assert.equal(deliveryTargets(hosts, env, process.platform, root).find(target => target.id === 'cursor-cli').available, false)
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent'), '', { mode: 0o755 })
  const offered = deliveryTargets(hosts, env, process.platform, root).find(target => target.id === 'cursor-cli')
  assert.equal(offered?.route, 'run')
  assert.match(offered.detail, /started by Ambio/); assert.doesNotMatch(offered.detail, /Experimental/)
  assert.equal(deliveryTargets([{ id: 'codex', label: 'Codex' }], env, process.platform, root).find(target => target.id === 'cursor-cli').available, true)
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

// A host that reads stream-json the way Claude Code does: each message is
// echoed and answered; the prompt "p" keeps its turn open until another
// message or an interrupt ends it. It leaves when its stdin is closed.
const streamingHost = ['-e', `
  const out = value => console.log(JSON.stringify(value))
  out({ type: 'system', subtype: 'init', session_id: 'stream-session' })
  require('readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line)
    if (message.type === 'user') {
      out({ type: 'user', isReplay: true, uuid: message.uuid, message: message.message })
      out({ type: 'assistant', session_id: 'stream-session', message: { content: [{ type: 'text', text: 'heard ' + message.message.content }] } })
      // Then starts writing more, which stays unfinished until the next message.
      for (const text of ['Still ', 'writing']) out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
      if (message.message.content !== 'p') out({ type: 'result', is_error: false, result: 'ok' })
    }
    if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } })
      out({ type: 'result', is_error: true, subtype: 'error_during_execution' })
    }
  }).on('close', () => process.exit(0))
`]
async function said(runner, key, text) {
  for (let i = 0; i < 400; i++) {
    if (runner.events('ws', key).some(event => event.text === text)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`never said ${text}: ${JSON.stringify(runner.events('ws', key))}`)
}
function streamingTurn(root, messageId) {
  const plan = deliveryPlan('claude-code', mcp, 'ws', 'p', { messageId })
  return {
    workspaceId: 'ws', messageId, hostId: 'claude-code', rootPath: root, revision: 'initial', prompt: 'p',
    launcher: { command: process.execPath, args: [] }, args: streamingHost, stdin: plan.stdin,
    threadId: 'thread', mode: 'build', driver: agentDriver('claude-code'), sessionId: plan.sessionId,
  }
}

test('a message sent while Claude Code works joins its turn, and the turn ends when the agent says so', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const started = await runner.start(streamingTurn(root, 'turn-steer'))
  await said(runner, started.key, 'heard p')
  // What it is still writing shows last as one live item, saved as it grows.
  await said(runner, started.key, 'Still writing')
  assert.equal(runner.list('ws').find(run => run.key === started.key).canSteer, true)
  const writing = runner.events('ws', started.key).at(-1)
  assert.equal(writing.live, true); assert.match(writing.id, /^live:/)
  // Resolves once the agent has taken it in, which is recorded in the turn.
  await runner.steer('ws', started.key, 'also check the tests')
  await said(runner, started.key, 'heard also check the tests')
  const events = runner.events('ws', started.key)
  assert.ok(events.some(event => event.kind === 'sent' && event.text === 'also check the tests'))
  // The live item was replaced in place by the whole message that followed it.
  assert.equal(events.find(event => event.id === writing.id).live, undefined)
  assert.equal(events.filter(event => event.live).length, events.at(-1).live ? 1 : 0)
  // The host leaves only because its stdin was closed when the turn ended.
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'completed')
  await assert.rejects(() => runner.steer('ws', started.key, 'too late'), /not accepting input/)
  await assert.rejects(() => runner.steer('other', started.key, 'x'), /not accepting input/)
  assert.match(fs.readFileSync(run.logPath, 'utf8'), /Sent into this turn: also check the tests/)
})

test('Stop asks Claude Code to end its turn, so it leaves on its own with its session intact', async t => {
  const root = fixture(t)
  const released = []
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn, async run => { released.push(run.messageId) })
  const started = await runner.start(streamingTurn(root, 'turn-stop'))
  await said(runner, started.key, 'heard p')
  assert.deepEqual(released, [])
  const asked = Date.now()
  await runner.stop('ws', started.key)
  // What the stopped turn still had waiting (a permission card, a question) is released, once.
  assert.deepEqual(released, ['turn-stop'])
  // Well inside the grace period after which it would have been ended.
  assert.ok(Date.now() - asked < 3000, `took ${Date.now() - asked}ms`)
  const run = runner.list('ws').find(item => item.key === started.key)
  assert.equal(run.state, 'stopped')
  assert.equal(run.sessionId, 'stream-session')
  // The interrupt was answered: the process was not killed mid-turn.
  assert.match(fs.readFileSync(run.logPath, 'utf8'), /"control_response"/)
  // Ending the stopped turn is not reported as an error of its own.
  assert.ok(!runner.events('ws', run.key).some(event => event.kind === 'error'))
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

test('Codex reads in a read-only sandbox, except on Windows where that sandbox cannot start a shell', () => {
  assert.equal(codexSandbox('ask', 'linux'), 'read-only')
  assert.equal(codexSandbox('propose', 'darwin'), 'read-only')
  assert.equal(codexSandbox('ask', 'win32'), 'danger-full-access')
  assert.equal(codexSandbox('build', 'linux'), 'danger-full-access')
})

test('Codex is asked for reasoning summaries and they reach the turn as thinking', () => {
  const codex = agentDriver('codex')
  assert.ok(deliveryPlan('codex', mcp, 'ws', 'p', { mode: 'ask' }).args.includes('model_reasoning_summary="auto"'))
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '**Checking the map**\n\nSkill Execution already has both runtimes.' } })
  assert.deepEqual(codex.read(line).events, [{ kind: 'thinking', text: 'Checking the map — Skill Execution already has both runtimes.' }])
  // One item can carry several summary sections, some only a heading; each is its own thought.
  const several = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '**Splitting large leaves**\n\n**Grouping indexer files**\n**Grouping state files**\n\nThe store and\nits migrations.' } })
  assert.deepEqual(codex.read(several).events.map(event => event.text), ['Splitting large leaves', 'Grouping indexer files', 'Grouping state files — The store and its migrations.'])
})

test('each agent\'s reasoning reaches the turn as thinking, where the agent shows it', () => {
  const claude = agentDriver('claude-code')
  const said = claude.read(JSON.stringify({ type: 'assistant', session_id: 's', message: { content: [
    { type: 'thinking', thinking: 'The **map** already\nhas both runtimes.' },
    { type: 'thinking', thinking: '', signature: 'x' },
    { type: 'text', text: 'Both exist.' },
  ] } }))
  // A thinking block the model left empty says nothing.
  assert.deepEqual(said.events.map(event => [event.kind, event.text]), [['thinking', 'The map already has both runtimes.'], ['text', 'Both exist.']])

  const cursor = agentDriver('cursor-cli')
  assert.deepEqual(cursor.read(JSON.stringify({ type: 'thinking', subtype: 'delta', session_id: 'c', text: 'Looking at ' })).events, [])
  assert.deepEqual(cursor.read(JSON.stringify({ type: 'thinking', subtype: 'delta', session_id: 'c', text: 'the sheet.' })).events, [])
  assert.deepEqual(cursor.read(JSON.stringify({ type: 'thinking', subtype: 'completed', session_id: 'c' })).events, [{ kind: 'thinking', text: 'Looking at the sheet.' }])

  const antigravity = agentDriver('antigravity-cli')
  // agy 1.4 reports only a count of thinking tokens: nothing to show.
  assert.deepEqual(antigravity.read(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'a', step_type: 'agent_response', state: 'DONE', usage: { thinking_tokens: 771 } } })).events, [])
  assert.deepEqual(antigravity.read(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'a', step_type: 'agent_response', thinking: 'Planning the reply.' } })).events, [{ kind: 'thinking', text: 'Planning the reply.' }])
})


test('direct driver plans retain the finite mapping credential and request binding', () => {
  const mapping = { attempt: { id: 'map-only' }, token: 'scoped-token' }
  for (const host of ['claude-code', 'codex', 'copilot-cli']) {
    const plan = deliveryPlan(host, mcp, 'ws', 'Map only', { mode: 'propose', messageId: 'request', mapping })
    const serialized = plan.args.join(' ')
    assert.match(serialized, /AMBIO_MAPPING_ATTEMPT/)
    assert.match(serialized, /map-only/)
    assert.match(serialized, /scoped-token/)
    assert.match(serialized, /AMBIO_RUN_MESSAGE_ID/)
  }
})
