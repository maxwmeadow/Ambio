// Native ACP and print peer. No vendor service or credentials are used.
const fs = require('node:fs')
const path = require('node:path')
const lines = require('node:readline')
// The catalog read switches models too, and runs with no capture file in unit tests.
const capture = value => { if (process.env.AMBIO_AGY_CAPTURE) fs.appendFileSync(process.env.AMBIO_AGY_CAPTURE, JSON.stringify(value) + '\n') }
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('Antigravity CLI 1.5.0'); process.exit(0) }
if (args.includes('models')) { console.log('gemini-fixture-high\tGemini Fixture High\ngemini-fixture-low\tGemini Fixture Low\nclaude-fixture\tClaude Fixture'); process.exit(0) }
if (args.includes('-p')) { capture({ transport: 'print', args }); console.log(JSON.stringify({ event: 'init', init: { conversation_id: 'print-session' } })); process.exit(0) }
if (!args.includes('acp')) throw new Error('Expected native acp command')
const sessionId = 'acp-session'
// Like agy 1.5.5: the thinking level is an option of the current model only,
// so it disappears when the session switches to a model without one.
let currentModel = 'gemini-fixture'
const optionsFor = value => [
  { id: 'model', category: 'model', options: [{ value: 'gemini-fixture', name: 'Gemini Fixture' }, { value: 'plain-fixture', name: 'Plain Fixture' }], currentValue: value },
  ...(value === 'gemini-fixture' ? [{ id: 'thought_level', category: 'thought_level', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }], currentValue: 'high' }] : []),
]
const send = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }))
const update = update => send({ method: 'session/update', params: { sessionId, update } })
let promptId
// A later conversation (after the steered one) ends its turn after the edit.
const steeredBefore = () => fs.existsSync(process.env.AMBIO_AGY_CAPTURE) && fs.readFileSync(process.env.AMBIO_AGY_CAPTURE, 'utf8').includes('"steering"')
const usage = { inputTokens: 100, outputTokens: 7, cachedReadTokens: 0, thoughtTokens: 2, totalTokens: 107 }
const reader = lines.createInterface({ input: process.stdin })
reader.on('line', line => {
  const { id, method, params, result } = JSON.parse(line)
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } })
  if (method === 'session/new' || method === 'session/resume') {
    if (params.mcpServers.length) capture({ transport: 'acp', resumed: method === 'session/resume', mcpServers: params.mcpServers, cwd: params.cwd })
    currentModel = 'gemini-fixture'
    return send({ id, result: { sessionId, configOptions: optionsFor(currentModel), models: { availableModels: [{ modelId: 'gemini-fixture-high', name: 'Gemini Fixture High' }, { modelId: 'gemini-fixture-low', name: 'Gemini Fixture Low' }] }, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } } })
  }
  if (method === 'session/close') return send({ id, result: {} })
  if (method === 'session/set_config_option') {
    capture({ configId: params.configId, value: params.value })
    if (params.configId === 'model') currentModel = params.value
    return send({ id, result: { configOptions: optionsFor(currentModel) } })
  }
  if (method === 'session/set_mode') return send({ id, result: {} })
  if (method === 'session/prompt') {
    if (promptId) {
      capture({ steering: params.prompt[0].text })
      // Match agy's lifecycle: original returns before the replacement reply.
      send({ id: promptId, result: { stopReason: 'end_turn', usage } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Corrected ' } })
      setTimeout(() => {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture reply.' } })
        send({ id, result: { stopReason: 'end_turn', usage } })
      }, 400)
      return
    }
    promptId = id
    capture({ prompt: params.prompt[0].text })
    update({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', title: 'Edit fixture.txt', status: 'pending' })
    return send({ id: 777, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'edit', kind: 'edit', title: 'Edit fixture.txt' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } })
  }
  if (id === 777 && result) {
    capture({ permission: result.outcome })
    if (result.outcome.optionId === 'yes') {
      fs.writeFileSync(path.join(process.cwd(), 'fixture.txt'), 'approved')
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', title: 'Edit fixture.txt', status: 'completed', content: [{ type: 'diff', path: 'fixture.txt', oldText: null, newText: 'approved' }] })
    }
    if (steeredBefore()) send({ id: promptId, result: { stopReason: 'end_turn', usage } })
    return
  }
  if (method === 'session/cancel') { capture({ cancelled: true }); send({ id: promptId, result: { stopReason: 'cancelled' } }); return }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported fixture method' } })
})
reader.on('close', () => process.exit(0))
