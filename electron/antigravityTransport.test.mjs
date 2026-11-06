import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpClient, acpModeFor, acpToolDetail } from './acpClient.ts'
import { antigravityOptions, antigravityRoute, inspectAntigravity } from './antigravityTransport.ts'
import { DeliveryRunner } from './agentDelivery.ts'

// Shape captured from signed-in agy 1.5.0; names are arbitrary to prevent
// routing code from recognizing a provider/model family instead of the catalog.
const catalog = {
  models: { availableModels: [{ modelId: 'offered-high', name: 'Offered High' }, { modelId: 'offered-low', name: 'Offered Low' }] },
  configOptions: [
    { id: 'model', category: 'model', options: [{ value: 'offered', name: 'Offered' }], currentValue: 'offered' },
    { id: 'thought_level', category: 'thought_level', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }], currentValue: 'high' },
  ],
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
}
const print = [{ id: 'offered-high', label: 'Offered High' }, { id: 'offered-low', label: 'Offered Low' }, { id: 'other-model', label: 'Other' }]

test('native catalog discovery opens and closes an empty session without prompting or tools', async () => {
  const fixture = fileURLToPath(new URL('../tests/e2e/fixtures/antigravity-agent.cjs', import.meta.url))
  const session = await inspectAntigravity({ command: process.execPath, args: [fixture] })
  assert.equal(session.models.availableModels.length, 2)
  assert.equal(session.configOptions[0].id, 'model')
})

test('catalog discovery unifies model variants with thinking controls and retains print-only models', () => {
  const options = antigravityOptions(print, catalog)
  assert.deepEqual(options.map(item => [item.id, item.transport]), [['offered', 'acp'], ['other-model', 'print']])
  assert.deepEqual(options[0].aliases, ['offered-high', 'offered-low'])
  assert.equal(options[0].defaultThinking, 'high')
  assert.deepEqual(options[0].thinkingLevels.map(item => item.id), ['low', 'high'])
  assert.deepEqual(antigravityRoute(options, 'offered'), { transport: 'acp', model: 'offered' })
  assert.deepEqual(antigravityRoute(options, 'other-model'), { transport: 'print', model: 'other-model' })
  assert.deepEqual(antigravityRoute(options, undefined), { transport: 'print' })
})

test('legacy selections and print conversations retain their transport, and ACP cannot silently change it', () => {
  const options = antigravityOptions(print, catalog)
  assert.deepEqual(antigravityRoute(options, 'offered-low', 'print'), { transport: 'print', model: 'offered-low' })
  assert.deepEqual(antigravityRoute(options, 'offered', 'print', 'low'), { transport: 'print', model: 'offered-low' })
  assert.deepEqual(antigravityRoute(options, 'offered-high'), { transport: 'acp', model: 'offered', thinking: 'high' })
  assert.throws(() => antigravityRoute(options, 'other-model', 'acp'), /new conversation/)
  assert.throws(() => antigravityRoute([], 'offered', 'acp'), /did not report/)
  // If the account/vendor later exposes another model, the same data-driven
  // routing works without maintaining a Gemini-prefix list.
  const future = antigravityOptions(print, { models: { availableModels: [{ modelId: 'other-model', name: 'Other' }] } })
  assert.equal(antigravityRoute(future, 'other-model').transport, 'acp')
  assert.throws(() => antigravityRoute(future, 'other-model', 'print', 'low'), /new conversation/)
  assert.ok(antigravityOptions(print, undefined).every(item => item.transport === 'print'))
})

function simulated(t, turn = {}, handler) {
  const sent = [], events = []
  let client
  const reply = (id, result) => client.receive(JSON.stringify({ jsonrpc: '2.0', id, result }))
  const error = (id, message) => client.receive(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32002, message } }))
  const emit = (method, params, id) => client.receive(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }))
  client = new AcpClient({ cwd: os.tmpdir(), prompt: 'original', mode: 'build', mcpServers: [], onSession: () => {}, onEvent: event => events.push(event), ...turn,
    send: line => {
      const message = JSON.parse(line); sent.push(message)
      if (!message.method) return
      queueMicrotask(() => {
        if (handler?.(message, { reply, error, emit }) === true) return
        const result = message.method === 'initialize' ? { agentCapabilities: { loadSession: true } }
          : message.method === 'session/new' ? { sessionId: 'retained', ...structuredClone(catalog) }
            : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        reply(message.id, result)
      })
    },
  })
  t.after(() => client.close())
  return { client, sent, events, reply, emit }
}

test('model, thinking and mode are configured before a prompt and unavailable models do no work', async t => {
  const { client, sent } = simulated(t, { model: 'offered', thinking: 'low', mode: 'propose', strictResume: true })
  await client.run()
  assert.deepEqual(sent.filter(item => item.method.startsWith('session/')).map(item => [item.method, item.params.configId ?? item.params.modeId]), [
    ['session/new', undefined], ['session/set_config_option', 'model'], ['session/set_config_option', 'thought_level'], ['session/set_mode', 'plan'], ['session/prompt', undefined],
  ])
  const unavailable = simulated(t, { model: 'other-model' })
  await assert.rejects(unavailable.client.run(), /selected model is not available/)
  assert.ok(!unavailable.sent.some(item => item.method === 'session/prompt'))
})

test('a strict retained session failure never creates a new session or prompt', async t => {
  const { client, sent } = simulated(t, { resume: 'lost', strictResume: true }, (message, { error }) => {
    if (message.method === 'session/load') { error(message.id, 'Session missing'); return true }
  })
  await assert.rejects(client.run(), /Session missing/)
  assert.ok(!sent.some(item => ['session/new', 'session/prompt'].includes(item.method)))
})

test('permission cards can allow or deny once; cancellation defeats a late approval', async t => {
  for (const allow of [true, false]) {
    const calls = []
    const run = simulated(t, { onPermission: async question => { calls.push(question); return allow } })
    await run.client.open()
    run.emit('session/request_permission', { sessionId: 'retained', toolCall: { kind: 'execute', title: 'Run checks' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }, 90)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 1)
    assert.equal(run.sent.find(item => item.id === 90).result.outcome.optionId, allow ? 'yes' : 'no')
  }
  let answer, signal
  const late = simulated(t, { onPermission: (_, abort) => { signal = abort; return new Promise(resolve => { answer = resolve }) } })
  await late.client.open()
  late.emit('session/request_permission', { sessionId: 'retained', toolCall: { kind: 'edit' }, options: [{ optionId: 'yes', kind: 'allow_once' }] }, 91)
  late.client.cancel(); answer(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signal.aborted, true)
  assert.equal(late.sent.find(item => item.id === 91).result.outcome.outcome, 'cancelled')
})

test('Ask refuses file edits before asking a human and ignores foreign-session traffic', async t => {
  assert.equal(acpModeFor('ask', catalog.modes.availableModes), undefined)
  assert.equal(acpModeFor('ask', catalog.modes.availableModes, true), 'default')
  let asks = 0
  const run = simulated(t, { mode: 'ask', onPermission: async () => { asks++; return true } })
  await run.client.open()
  run.emit('session/request_permission', { sessionId: 'retained', toolCall: { kind: 'edit', title: 'Edit' }, options: [{ optionId: 'no', kind: 'reject_once' }] }, 90)
  run.emit('session/update', { sessionId: 'foreign', update: { sessionUpdate: 'tool_call', title: 'Wrong session' } })
  assert.equal(asks, 0)
  assert.equal(run.sent.find(item => item.id === 90).result.outcome.optionId, 'no')
  assert.ok(!run.events.some(event => event.text === 'Wrong session'))
})

test('steering is sent to the running session and records only acknowledged input', async t => {
  let original, finish
  const run = simulated(t, { steering: true }, (message, { reply }) => {
    if (message.method === 'session/prompt' && message.params.prompt[0].text === 'original') { original = message.id; finish = reply; return true }
  })
  const running = run.client.run()
  while (!original) await new Promise(resolve => setImmediate(resolve))
  await run.client.steer('Check the regression first')
  assert.equal(run.sent.filter(item => item.method === 'session/prompt').at(-1).params.sessionId, 'retained')
  assert.deepEqual(run.events.at(-1), { kind: 'sent', text: 'Check the regression first' })
  finish(original, { stopReason: 'end_turn' }); await running
  await assert.rejects(run.client.steer('Too late'), /not accepting/)
})

test('a turn stays alive when agy ends the original request before its steered replacement', async t => {
  const prompts = []
  const run = simulated(t, { steering: true }, (message, { reply }) => {
    if (message.method === 'session/prompt') { prompts.push({ id: message.id, reply }); return true }
  })
  let finished = false
  const running = run.client.run().then(() => { finished = true })
  while (prompts.length < 1) await new Promise(resolve => setImmediate(resolve))
  const steering = run.client.steer('Updated instruction')
  while (prompts.length < 2) await new Promise(resolve => setImmediate(resolve))
  prompts[0].reply(prompts[0].id, { stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  run.emit('session/update', { sessionId: 'retained', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Corrected reply' } } })
  prompts[1].reply(prompts[1].id, { stopReason: 'end_turn' })
  await steering; await running
  assert.equal(run.events.at(-1).text, 'Corrected reply')
})

test('tool content becomes bounded output and a unified diff, and unrenderable objects are dropped', () => {
  const result = acpToolDetail([{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }, { type: 'content', content: { type: 'text', text: 'x'.repeat(70000) } }, { type: 'content', content: { type: 'image', data: 'ignored' } }], { exit_code: 0 })
  assert.equal(result.diff, '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new')
  assert.equal(result.output.length, 64000)
  assert.equal(result.exitCode, 0)
})

test('transport receipts survive restart and pre-upgrade CLI conversations mean print', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-agy-pin-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const receipt = { workspaceId: 'ws', hostId: 'antigravity-cli', threadId: 'old', state: 'completed', startedAt: 1 }
  fs.writeFileSync(path.join(root, `${'a'.repeat(64)}.json`), JSON.stringify(receipt))
  fs.writeFileSync(path.join(root, `${'b'.repeat(64)}.json`), JSON.stringify({ ...receipt, threadId: 'new', transport: 'acp' }))
  const runner = new DeliveryRunner(root)
  assert.equal(runner.conversationTransport('ws', 'old', 'antigravity-cli'), 'print')
  assert.equal(runner.conversationTransport('ws', 'new', 'antigravity-cli'), 'acp')
  assert.equal(runner.conversationTransport('other', 'new', 'antigravity-cli'), undefined)
})

test('the retired Antigravity ACP agent\'s conversations continue as Antigravity CLI over ACP', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-agy-retired-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  // Receipts from before transports were recorded carry none; the ACP agent always meant ACP.
  fs.writeFileSync(path.join(root, `${'c'.repeat(64)}.json`), JSON.stringify({ workspaceId: 'ws', hostId: 'antigravity-acp', threadId: 'acp', state: 'completed', startedAt: 1 }))
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify({ [JSON.stringify(['ws', 'acp', 'antigravity-acp'])]: 'agy-session' }))
  const runner = new DeliveryRunner(root)
  assert.deepEqual(runner.list('ws').map(run => [run.hostId, run.transport]), [['antigravity-cli', 'acp']])
  assert.equal(runner.conversationTransport('ws', 'acp', 'antigravity-cli'), 'acp')
  assert.equal(runner.session('ws', 'acp', 'antigravity-cli'), 'agy-session')
})
