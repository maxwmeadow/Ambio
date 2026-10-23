// Protocol peers for UI/runner tests; no vendor credentials or model service.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const host = process.env.AMBIO_AGENT_HOST
if (process.argv.includes('models')) {
  console.log('Available models:\n  * fixture-model (default)')
  process.exit(0)
}
const muse = host === 'muse'
const args = muse ? [path.basename(process.argv[1]), ...process.argv.slice(2)] : process.argv.slice(2)
if (muse && JSON.stringify(args) !== JSON.stringify(['serve'])) throw new Error('Muse peer accepts plain serve only')
if (process.env.AMBIO_FIXTURE_SANDBOX_FAIL) {
  console.error('bwrap exec failed: No such file or directory. Refusing to start with denied paths unprotected')
  process.exit(1)
}
const sessionId = '0198f0aa-1111-7000-8000-0000000000aa'
let servers = [], promptId, turnId
const send = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }))
const update = text => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
const capture = prompt => {
  fs.writeFileSync(`captured-${host}.json`, JSON.stringify({ args, prompt, cwd: process.cwd(), workspace: process.env.AMBIO_WORKSPACE_ID, mcpServers: servers, permissionHook: process.env.AMBIO_RUN_MESSAGE_ID }))
}
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  const { id, method, params, result } = JSON.parse(line)
  if (method === 'initialize') return send({ id, result: muse ? { schema: { version: 1 } } : { protocolVersion: 1, authMethods: [{ id: 'cached_token' }], agentCapabilities: { loadSession: true } } })
  if (method === 'initialized') return
  if (method === 'model/list') return send({ id, result: { models: [] } })
  if (method === 'authenticate') return send({ id, result: {} })
  if (method === 'session/new' || method === 'session/load') {
    servers = params.mcpServers
    return send({ id, result: { sessionId } })
  }
  if (method === 'session/start' || method === 'session/resume') {
    servers = params.config.mcpServers
    return send({ id, result: { session: { sessionId, workspaceRoot: process.cwd() } } })
  }
  if (method === 'session/setModel' || method === 'session/setApprovalMode') return send({ id, result: {} })
  if (method === 'session/prompt') {
    promptId = id
    capture(params.prompt[0].text)
    if (process.env.AMBIO_FIXTURE_WAIT) return
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'edit-1', kind: 'edit', title: 'Edit fixture.txt' } } })
    return send({ id: 777, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit fixture.txt' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } })
  }
  if (id === 777 && result) {
    const choice = result.outcome.optionId
    if (choice === 'yes') fs.writeFileSync('fixture-edited.txt', 'edited')
    update(`Edit permission: ${choice}`)
    return send({ id: promptId, result: { stopReason: 'end_turn' } })
  }
  if (method === 'turn/start') {
    turnId = params.commandId
    capture(params.input[0].text)
    send({ id, result: { turnId, disposition: 'started', status: 'accepted' } })
    if (process.env.AMBIO_FIXTURE_WAIT) return
    send({ method: 'item/completed', params: { sessionId, item: { itemId: 'reply', turnId, kind: 'agentMessage', text: 'Fixture Muse finished.' } } })
    return send({ method: 'turn/completed', params: { sessionId, turnId, terminal: 'completed' } })
  }
  if (method === 'session/cancel' || method === 'turn/interrupt') {
    if (id !== undefined) send({ id, result: { status: 'accepted' } })
    return
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unsupported fixture method ${method}` } })
})
lines.on('close', () => process.exit(0))
