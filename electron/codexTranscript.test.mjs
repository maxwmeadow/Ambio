import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DeliveryRunner } from './agentDelivery.ts'
import { agentDriver } from './agentDrivers.ts'
import { codexTranscriptEvents, codexTranscriptPath, followCodexTranscript, scriptSummary } from './codexTranscript.ts'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-codex-transcript-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const script = (input, timestamp = '2026-10-28T19:41:59.000Z') => JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } })
const reasoning = JSON.stringify({ timestamp: '2026-10-28T19:41:58.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } })
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(20) }
  assert.fail('condition was not met')
}

test('a script that only works on data in memory shows as a Script line', () => {
  assert.deepEqual(codexTranscriptEvents(script('const x=load("ambio_final_assignments");\ntext(x.length)')), [{ kind: 'tool', text: 'Script · reads ambio_final_assignments' }])
})

test('a script that calls a tool is left to --json, which reports the call', () => {
  assert.deepEqual(codexTranscriptEvents(script('const r = await tools.exec_command({cmd:"ls"})')), [])
  assert.deepEqual(codexTranscriptEvents(script('const r = await tools["mcp__ambio__edit_systems"]({op:"add_chunk"})')), [])
})

test('scripts from earlier turns, other entries and unreadable lines add nothing', () => {
  assert.deepEqual(codexTranscriptEvents(script('text(1)', '2026-10-28T19:00:00.000Z'), Date.parse('2026-10-28T19:30:00.000Z')), [])
  assert.deepEqual(codexTranscriptEvents(reasoning), [])
  assert.deepEqual(codexTranscriptEvents('{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":42}}'), [])
  assert.deepEqual(codexTranscriptEvents('not json'), [])
  assert.deepEqual(codexTranscriptEvents('{"kind":"something else"}'), [])
})

test('a script is described by its comment, else what it saves and reads, else its first line', () => {
  assert.equal(scriptSummary('\n// Check every file is assigned\nconst a = load("x");'), 'Check every file is assigned')
  assert.equal(scriptSummary('const files = load("files"), defs = load(\'defs\');\nstore("assignments", files)\nload("files")'), 'saves assignments · reads files, defs')
  assert.equal(scriptSummary('load("a");load("b");load("c");load("d");load("e")'), 'reads a, b, c +2')
  assert.equal(scriptSummary('{\n  const   extra = [1, 2];\n}'), 'const extra = [1, 2]')
  assert.equal(scriptSummary(`text("${'x'.repeat(200)}")`).length, 101)
  assert.equal(scriptSummary('  \n'), 'working on data in memory')
})

test('the transcript is found by session id in the day\'s folder under CODEX_HOME', t => {
  const home = fixture(t)
  const now = new Date(2026, 9, 28, 15, 37)
  const folder = path.join(home, 'sessions', '2026', '10', '28')
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, 'rollout-2026-10-28T15-37-38-01a18404-a077-7fa0-9702-65484a06267a.jsonl')
  fs.writeFileSync(file, '')
  assert.equal(codexTranscriptPath('01a18404-a077-7fa0-9702-65484a06267a', { CODEX_HOME: home }, now), file)
  assert.equal(codexTranscriptPath('01a18404-0000-0000-0000-000000000000', { CODEX_HOME: home }, now), undefined)
  assert.equal(codexTranscriptPath('../../etc', { CODEX_HOME: home }, now), undefined)
})

test('following reports scripts as they are written, holding a half-written line', async t => {
  const file = path.join(fixture(t), 'rollout.jsonl')
  fs.writeFileSync(file, `${reasoning}\n`)
  const events = [], notes = []
  const stop = followCodexTranscript({ sessionId: 's', since: 0, locate: () => file, report: event => events.push(event), note: text => notes.push(text) })
  t.after(stop)
  const line = script('const total = load("files").length')
  fs.appendFileSync(file, line.slice(0, 20))
  await wait(700)
  assert.deepEqual(events, [])
  fs.appendFileSync(file, `${line.slice(20)}\n${script('await tools.exec_command({cmd:"ls"})')}\n`)
  await until(() => events.length === 1)
  fs.appendFileSync(file, `${script('text("done")')}\n`)
  stop()
  assert.deepEqual(events.map(event => event.text), ['Script · reads files', 'Script · text("done")'])
  assert.deepEqual(notes, [])
})

test('a transcript in a format Ambio does not know is let go quietly', async t => {
  const file = path.join(fixture(t), 'rollout.jsonl')
  fs.writeFileSync(file, `${Array.from({ length: 60 }, (_, i) => JSON.stringify({ event: 'renamed', n: i, input: 'text(1)' })).join('\n')}\n`)
  const events = [], notes = []
  const stop = followCodexTranscript({ sessionId: 's', since: 0, locate: () => file, report: event => events.push(event), note: text => notes.push(text) })
  t.after(stop)
  await until(() => notes.length === 1)
  fs.appendFileSync(file, `${script('text(1)')}\n`)
  await wait(700)
  assert.deepEqual(events, [])
  assert.match(notes[0], /format is not one Ambio recognises/)
})

test('no transcript, or one that cannot be read, ends the following with a note', async t => {
  const notes = []
  const stopMissing = followCodexTranscript({ sessionId: 's', since: 0, findMs: 0, locate: () => undefined, report: () => assert.fail('nothing to report'), note: text => notes.push(text) })
  t.after(stopMissing)
  const stopBroken = followCodexTranscript({ sessionId: 's', since: 0, locate: () => { throw new Error('permission denied') }, report: () => assert.fail('nothing to report'), note: text => notes.push(text) })
  t.after(stopBroken)
  await until(() => notes.length === 2)
  assert.ok(notes.some(note => /no transcript was found/.test(note)))
  assert.ok(notes.some(note => /permission denied/.test(note)))
})

test('the real mapping transcript shape yields only the tool-free scripts', () => {
  // Abridged from a codex-cli 0.165.0 mapping session.
  const lines = [
    JSON.stringify({ timestamp: '2026-10-28T19:37:38.822Z', ordinal: 0, type: 'session_meta', payload: { id: '01a18404', cli_version: '0.165.0' } }),
    JSON.stringify({ timestamp: '2026-10-28T19:38:20.000Z', ordinal: 40, type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_1', name: 'exec', input: 'const r=await tools.mcp__ambio__edit_systems({op:"begin_session"});\ntext(r);\n' } }),
    JSON.stringify({ timestamp: '2026-10-28T19:39:51.000Z', ordinal: 90, type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_2', status: 'completed', call_id: 'call_2', name: 'exec', input: 'const files=load("ambio_index_files");\nconst defs=[];\n' } }),
    JSON.stringify({ timestamp: '2026-10-28T19:39:52.000Z', ordinal: 91, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'Script completed' }] } }),
    JSON.stringify({ timestamp: '2026-10-28T19:39:53.000Z', ordinal: 92, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning' } } }),
  ]
  assert.deepEqual(lines.flatMap(line => codexTranscriptEvents(line, Date.parse('2026-10-28T19:37:38.000Z'))), [{ kind: 'tool', text: 'Script · reads ambio_index_files' }])
})

test('a Codex turn shows the tool-free scripts its transcript records, even one written just before it exits', async t => {
  const root = fixture(t)
  const codexHome = path.join(root, 'codex-home')
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous })
  const agent = path.join(root, 'codex.cjs')
  // Prints --json as Codex does, and writes its transcript where Codex would.
  fs.writeFileSync(agent, `
const fs = require('node:fs'), path = require('node:path')
const id = '01a18404-a077-7fa0-9702-65484a06267a', now = new Date(), pad = n => String(n).padStart(2, '0')
const folder = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
fs.mkdirSync(folder, { recursive: true })
const file = path.join(folder, 'rollout-2026-10-28T15-37-38-' + id + '.jsonl')
const entry = input => JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } }) + '\\n'
console.log(JSON.stringify({ type: 'thread.started', thread_id: id }))
fs.appendFileSync(file, entry('const r = await tools.exec_command({cmd:"ls"})'))
console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }))
setTimeout(() => {
  fs.appendFileSync(file, entry('store("groups", load("files"))'))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Mapped.' } }))
}, 800)
`)
  const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
  const started = await runner.start({
    workspaceId: 'ws', messageId: 'turn', hostId: 'codex', rootPath: root, revision: 'initial', prompt: 'Map it',
    launcher: { command: process.execPath, args: [] }, args: [agent], threadId: 'thread', mode: 'propose', driver: agentDriver('codex'),
  })
  const run = await settled(runner, 'ws', started.key)
  assert.equal(run.state, 'completed', run.detail)
  assert.equal(run.sessionId, '01a18404-a077-7fa0-9702-65484a06267a')
  assert.deepEqual(runner.events('ws', run.key).map(event => [event.kind, event.text]), [
    ['tool', 'Shell · ls'],
    ['text', 'Mapped.'],
    ['tool', 'Script · saves groups · reads files'],
  ])
})
