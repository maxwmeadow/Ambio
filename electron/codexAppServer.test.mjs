import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { CodexAppServerClient, chatGPTAppServerArguments } from './codexAppServer.ts'
import { DeliveryRunner } from './agentDelivery.ts'

function protocol(overrides = {}) {
  const sent = [], events = [], sessions = []
  const client = new CodexAppServerClient({
    cwd: '/project', prompt: 'Claim this turn', model: 'account-model', version: '0.1.0', mode: 'ask',
    onSession: id => sessions.push(id), onEvent: event => events.push(event),
    send(line) {
      const message = JSON.parse(line); sent.push(message)
      if (!message.method || message.id === undefined) return
      queueMicrotask(() => {
        let result = {}
        if (message.method.startsWith('thread/')) result = { thread: { id: 'thread-one' } }
        if (message.method === 'thread/resume' && overrides.missingResume) {
          client.receive(JSON.stringify({ id: message.id, error: { code: -1, message: 'gone' } })); return
        }
        if (message.method === 'turn/start') result = { turn: { id: 'turn-one' } }
        client.receive(JSON.stringify({ id: message.id, result }))
        if (message.method === 'turn/start') queueMicrotask(() => {
          client.receive(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-one', itemId: 'item', delta: 'Hello from ChatGPT' } }))
          client.receive(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: overrides.status ?? 'completed' } } }))
        })
      })
    },
    ...overrides,
  })
  return { client, sent, events, sessions }
}

test('app-server attributes Ambio, sets the selected model and sandbox on every turn, and waits for completed inference', async () => {
  for (const mode of ['ask', 'propose', 'build']) {
    const { client, sent, events, sessions } = protocol({ mode })
    assert.deepEqual(await client.run(), { stopReason: 'end_turn', resumed: false })
    assert.deepEqual(sent[0].params.clientInfo, { name: 'Ambio', title: 'Ambio', version: '0.1.0' })
    assert.equal(sent[1].method, 'initialized')
    assert.equal(sent.find(message => message.method === 'thread/start').params.sandbox, mode === 'build' ? 'workspace-write' : 'read-only')
    const start = sent.find(message => message.method === 'turn/start')
    assert.equal(start.params.model, 'account-model')
    assert.equal(start.params.approvalPolicy, 'never')
    assert.equal(start.params.sandboxPolicy.type, mode === 'build' ? 'workspaceWrite' : 'readOnly')
    assert.deepEqual(sessions, ['thread-one'])
    assert.deepEqual(events, [{ kind: 'text', text: 'Hello from ChatGPT' }])
    client.close()
  }
})

test('resumes sessions, recovers a missing session, and treats failed or interrupted inference as failure', async () => {
  for (const missingResume of [false, true]) {
    const { client, sent } = protocol({ resume: 'thread-one', missingResume })
    assert.equal((await client.run()).resumed, !missingResume)
    assert.equal(sent.some(message => message.method === 'thread/start'), missingResume)
    client.close()
  }
  for (const status of ['failed', 'interrupted', 'incomplete']) {
    const { client, events } = protocol({ status })
    assert.notEqual((await client.run()).stopReason, 'end_turn')
    assert.equal(events.at(-1).kind, 'error')
    client.close()
  }
})

test('rejects unimplemented server requests and declines sandbox escalation', () => {
  const { client, sent } = protocol()
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    client.receive(JSON.stringify({ id: 22, method, params: {} }))
    assert.equal(sent.at(-1).result.decision, 'decline')
  }
  client.receive(JSON.stringify({ id: 23, method: 'item/permissions/requestApproval', params: {} }))
  assert.deepEqual(sent.at(-1).result.permissions, {})
  client.receive(JSON.stringify({ id: 24, method: 'unexpected/action', params: {} }))
  assert.equal(sent.at(-1).error.code, -32601)
  client.close()
})

test('the public API provider cannot fall back to Codex login and MCP/shell do not receive the plan token', () => {
  const args = chatGPTAppServerArguments({ mcp: { command: 'node', args: ['ambio-mcp.js'] }, workspaceId: 'workspace', messageId: 'message' })
  assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://'])
  assert.ok(args.includes('model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"'))
  assert.ok(args.includes('model_providers.openai_chatgpt_plan.requires_openai_auth=false'))
  assert.ok(args.includes('model_providers.openai_chatgpt_plan.supports_websockets=false'))
  assert.ok(args.includes('mcp_servers.ambio.env.AMBIO_CHATGPT_ACCESS_TOKEN=""'))
  assert.ok(args.includes('shell_environment_policy.exclude=["AMBIO_CHATGPT_ACCESS_TOKEN"]'))
})

// A real subprocess exercises the runner's stdio transport, receipts, stream
// completion and log boundary, including a malicious credential diagnostic.
const SERVER = `
const lines = require('node:readline').createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
lines.on('line', line => {
  const message = JSON.parse(line)
  const { id, method, params } = message
  if (id === undefined) return
  if (method === 'initialize') return send({ id, result: {} })
  if (method === 'thread/start' || method === 'thread/resume') {
    if (!process.env.AMBIO_CHATGPT_ACCESS_TOKEN || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(6)
    return send({ id, result: { thread: { id: 'saved-thread' } } })
  }
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'turn-one' } } })
    console.error(process.env.AMBIO_CHATGPT_ACCESS_TOKEN)
    send({ method: 'item/agentMessage/delta', params: { threadId: 'saved-thread', itemId: 'reply', delta: 'x'.repeat(998) + process.env.AMBIO_CHATGPT_ACCESS_TOKEN.slice(0, 6) } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'saved-thread', itemId: 'reply', delta: process.env.AMBIO_CHATGPT_ACCESS_TOKEN.slice(6) } })
    if (process.env.DROP_STREAM) return process.exit(0)
    send({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'turn-one', status: process.env.TURN_STATUS || 'completed' } } })
  }
})
lines.on('close', () => process.exit(0))
`

async function settled(runner, key) {
  for (let index = 0; index < 600; index++) {
    const run = runner.list('workspace').find(run => run.key === key)
    if (!['starting', 'running', 'stopping'].includes(run?.state)) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('App-server did not finish')
}

test('runner completes protocol turns, isolates account sessions and keeps tokens out of files', async t => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'ambio-app-server-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const server = join(directory, 'server.cjs')
  fs.writeFileSync(server, SERVER)
  const runner = new DeliveryRunner(join(directory, 'runs'), (command, args, options) => {
    const env = { ...options.env }; delete env.NODE_TEST_CONTEXT
    return spawn(command, args, { ...options, env })
  })
  t.after(() => runner.stopAll())
  for (const [index, outcome] of ['completed', 'failed', 'drop'].entries()) {
    const run = await runner.start({
      workspaceId: 'workspace', messageId: `message-${index}`, hostId: 'chatgpt', rootPath: directory, revision: 'initial',
      launcher: { command: process.execPath, args: [] }, args: [server], prompt: 'Claim the request', threadId: 'conversation', mode: 'ask', sessionScope: 'account-one',
      codexAppServer: { model: 'selected-model', version: '0.1.0', token: 'private-plan-token' },
      environment: { AMBIO_CHATGPT_ACCESS_TOKEN: 'private-plan-token', OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, TURN_STATUS: outcome, DROP_STREAM: outcome === 'drop' ? '1' : '' },
    })
    const finished = await settled(runner, run.key)
    assert.equal(finished.state, outcome === 'completed' ? 'completed' : 'failed')
    if (outcome === 'completed') assert.match(runner.events('workspace', run.key)[0].text, /\[redacted\]/)
    assert.equal(runner.session('workspace', 'conversation', 'chatgpt', 'account-one'), 'saved-thread')
    assert.equal(runner.session('workspace', 'conversation', 'chatgpt', 'account-two'), undefined)
    for (const filename of fs.readdirSync(join(directory, 'runs'))) {
      assert.equal(fs.readFileSync(join(directory, 'runs', filename), 'utf8').includes('private-plan-token'), false, filename)
    }
  }
})
