import assert from 'node:assert/strict'
import test from 'node:test'
import { antigravityModels, codexModels, copilotModels, grokModels, validModel } from './agentModels.ts'
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

// Captured from the official @xai-official/grok 1.0.67 native binary, without login.
test('Grok catalog excludes authentication notices and its default heading', () => {
  assert.deepEqual(grokModels('You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n'), [{ id: 'grok-4.6', label: 'grok-4.6' }, { id: 'grok-4.5', label: 'grok-4.5' }])
})
