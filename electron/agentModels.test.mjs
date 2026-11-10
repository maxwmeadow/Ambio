import assert from 'node:assert/strict'
import test from 'node:test'
import { antigravityModels, codexModels, copilotModels, grokModels, validModel, codexAvailableAccess, codexAccessPending, inspectCodex } from './agentModels.ts'
import { deliveryPlan } from './agentDelivery.ts'

test('each agent’s own model list is read the way it publishes it', () => {
  assert.deepEqual(codexModels(JSON.stringify({ models: [
    { slug: 'b', display_name: 'B', visibility: 'list', priority: 2 },
    { slug: 'hidden', display_name: 'H', visibility: 'hide', priority: 0 },
    { slug: 'a', display_name: 'A', visibility: 'list', priority: 1 },
  ] })), [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
  assert.deepEqual(codexModels('not json'), [])
  const help = [
    '  `defaultMode`: agent mode', '    - One of "interactive"', '',
    '  `model`: AI model to use for Copilot CLI', '    - "claude-sonnet-5.5"', '    - "gpt-6.1-sol"', '',
    '  `other`: something', '    - "not-a-model"',
  ].join('\n')
  assert.deepEqual(copilotModels(help).map(model => model.id), ['claude-sonnet-5.5', 'gpt-6.1-sol'])
  assert.deepEqual(antigravityModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'), [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }])
  assert.equal(validModel('claude-opus-5-5'), true)
  assert.equal(validModel('x; rm -rf /'), false)
})

test('a chosen model reaches each agent with its own flag, and none is passed by default', () => {
  const mcp = { command: 'node', args: ['mcp.js'] }
  const turn = { mode: 'ask', model: 'opus' }
  const args = host => deliveryPlan(host, mcp, 'ws', 'p', turn).args
  for (const host of ['claude-code', 'copilot-cli', 'cursor-cli', 'antigravity-cli', 'grok']) assert.equal(args(host)[args(host).indexOf('--model') + 1], 'opus', host)
  assert.ok(args('codex').includes('model="opus"'))
  for (const host of ['claude-code', 'codex', 'copilot-cli']) {
    const plain = deliveryPlan(host, mcp, 'ws', 'p', { mode: 'ask' }).args
    assert.ok(!plain.includes('--model') && !plain.some(arg => arg.startsWith('model=')), host)
  }
})

test('a chosen effort reaches Claude Code and Codex with their own flags, and none is passed by default', () => {
  const mcp = { command: 'node', args: ['mcp.js'] }
  const claude = deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'ask', model: 'opus', effort: 'xhigh' }).args
  assert.equal(claude[claude.indexOf('--effort') + 1], 'xhigh')
  assert.ok(deliveryPlan('codex', mcp, 'ws', 'p', { mode: 'ask', model: 'gpt-6.1-sol', effort: 'high' }).args.includes('model_reasoning_effort="high"'))
  assert.ok(!deliveryPlan('claude-code', mcp, 'ws', 'p', { mode: 'ask', model: 'opus' }).args.includes('--effort'))
  assert.ok(!deliveryPlan('codex', mcp, 'ws', 'p', { mode: 'ask' }).args.some(arg => arg.startsWith('model_reasoning_effort=')))
})

// Captured from the official @xai-official/grok 1.0.67 native binary, without login.
test('Grok catalog excludes authentication notices and its default heading', () => {
  assert.deepEqual(grokModels('You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n'), [{ id: 'grok-4.6', label: 'grok-4.6' }, { id: 'grok-4.5', label: 'grok-4.5' }])
})

test('Codex host access returns immediately while delayed discovery runs, then uses the qualified cache', async () => {
  const launcher = { command: process.execPath, args: ['-e', `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;setTimeout(()=>console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{userAgent:'codex/0.163.0'}:{data:[]}})),150)})`] }
  const cold = codexAvailableAccess(launcher)
  assert.deepEqual(cold, ['ask', 'full'])
  // The host list says its levels are still coming, so the inbox reads it again.
  assert.equal(codexAccessPending(launcher), true)
  assert.deepEqual(codexAvailableAccess(launcher), ['ask', 'full'])
  await inspectCodex(launcher)
  assert.deepEqual(codexAvailableAccess(launcher), ['ask', 'auto', 'full'])
  assert.equal(codexAccessPending(launcher), false)
  const older = { command: process.execPath, args: ['-e', `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{userAgent:'codex/0.162.0'}:{data:[]}}))})`] }
  assert.deepEqual(codexAvailableAccess(older), ['ask', 'full'])
  await inspectCodex(older)
  assert.deepEqual(codexAvailableAccess(older), ['ask', 'full'])
  // A server that will not start is not started again on every host-list read.
  const broken = { command: process.execPath, args: ['-e', 'process.exit(1)'] }
  const failed = inspectCodex(broken)
  assert.equal((await failed).userAgent, '')
  assert.equal(inspectCodex(broken), failed)
  assert.equal(codexAccessPending(broken), false)
  assert.deepEqual(codexAvailableAccess(broken), ['ask', 'full'])
})
