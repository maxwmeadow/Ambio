import assert from 'node:assert/strict'
import test from 'node:test'

import { commandKind, connectionCheckPrompt, presentAgentHost } from './connectAgentPresentation.ts'

const host = overrides => ({
  id: 'codex',
  label: 'Codex',
  detected: true,
  configured: false,
  configuredPaths: [],
  unreadablePaths: [],
  workflowInstalled: false,
  workflowPath: null,
  configPath: 'config.toml',
  command: '$ambio-map',
  ...overrides,
})

test('agent host signal has one unambiguous state and action', () => {
  assert.deepEqual(presentAgentHost(host({ detected: false }), undefined, false), {
    state: 'missing',
    detail: 'Codex was not found on this machine. Install it before adding Ambio.',
    action: 'none',
  })
  assert.equal(presentAgentHost(host({}), undefined, false).state, 'available')
  assert.equal(presentAgentHost(host({ configured: true }), undefined, false).state, 'repair')
  assert.equal(presentAgentHost(host({ configured: true, workflowInstalled: true }), undefined, false).state, 'installed')
  assert.equal(presentAgentHost(host({ configured: true, workflowInstalled: true }), undefined, true).state, 'live')
})

test('a successful install immediately reads as installed while host inspection refreshes', () => {
  assert.equal(presentAgentHost(host({}), { ok: true, detail: 'done', paths: [] }, false).state, 'installed')
})

test('each harness invocation is described by its actual syntax', () => {
  assert.equal(commandKind('/ambio-map'), 'slash command')
  assert.equal(commandKind('$ambio-map'), 'skill command')
  assert.equal(commandKind('Use the ambio-map skill'), 'instruction')
})

test('connection check names the exact project and avoids claiming work', () => {
  const prompt = connectionCheckPrompt({ id: 'workspace-42', name: 'Draft', rootPath: '/tmp/draft' })
  assert.match(prompt, /get_inbox with verifyOnly true and expectedWorkspaceId "workspace-42"/)
  assert.match(prompt, /Do not claim or work on any request/)
  assert.match(prompt, /\/tmp\/draft/)
})

test('agents are listed installed first, then found on this computer, then the rest', async () => {
  const { orderAgentFamilies, familySummary } = await import('./connectAgentPresentation.ts')
  const host = (id, facts = {}) => ({
    id, label: id, modalityLabel: id, detected: false, configured: false, workflowInstalled: false,
    unreadablePaths: [], configuredPaths: [], command: null, ...facts,
  })
  const family = (id, ...modalities) => ({ id, label: id, modalities })
  const families = [
    family('missing-a', host('m1')),
    family('available-a', host('a1', { detected: true })),
    family('installed', host('i1', { detected: true, configured: true, workflowInstalled: true }), host('i2', { detected: true })),
    family('missing-b', host('m2')),
    family('broken', host('b1', { detected: true, configured: true })),
    family('available-b', host('a2', { detected: true })),
    family('live', host('l1', { detected: true, configured: true, workflowInstalled: true })),
  ]
  const ordered = orderAgentFamilies(families, {}, new Set(['l1']))
  assert.deepEqual(ordered.map(item => item.family.id),
    ['live', 'broken', 'installed', 'available-a', 'available-b', 'missing-a', 'missing-b'])
  const summary = id => familySummary(ordered.find(item => item.family.id === id).presentation, id === 'installed' ? 1 : 0)
  assert.equal(summary('live'), 'Connected now')
  assert.equal(summary('installed'), 'Installed · 1 more available')
  assert.equal(summary('broken'), 'Needs repair')
  assert.equal(summary('available-a'), 'Not installed')
  assert.equal(summary('missing-a'), 'Not found')
})

test('an install says it worked and what to do next; a failure keeps the reason the installer gave', async () => {
  const { installOutcomeNote } = await import('./connectAgentPresentation.ts')
  const host = { label: 'Claude', modalityLabel: 'Claude Code (CLI)', restartDetail: 'Close the existing terminal session and run claude in a new one.' }
  assert.deepEqual(installOutcomeNote(host, 'install', { ok: true, detail: 'Added Ambio and installed the /ambio-map skill.' }),
    { ok: true, text: 'Installed. Next: close the existing terminal session and run claude in a new one.' })
  assert.deepEqual(installOutcomeNote(host, 'remove', { ok: true, detail: 'whatever' }), { ok: true, text: 'Removed from Claude Code (CLI).' })
  assert.deepEqual(installOutcomeNote(host, 'install', { ok: false, detail: 'C:/x/.claude.json could not be read as JSON.' }),
    { ok: false, text: 'C:/x/.claude.json could not be read as JSON.' })
})
