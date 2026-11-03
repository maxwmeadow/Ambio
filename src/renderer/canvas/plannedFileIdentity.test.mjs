import assert from 'node:assert/strict'
import test from 'node:test'
import { plannedFilename, renamePlannedFile, plannedFileProperties, plannedFileSymbols, fileSymbolTab, plannedDescription } from './plannedFileIdentity.ts'

test('a planned file has one real filename and preserves its directory', () => {
  const node = { name: 'Scene Replay CLI', declaredPath: 'backend/replay_scene.py' }
  assert.equal(plannedFilename(node), 'replay_scene.py')
  assert.deepEqual(renamePlannedFile(node, 'replay.py'), { name: 'replay.py', declaredPath: 'backend/replay.py' })
  assert.deepEqual(renamePlannedFile(node, 'backend/replay_scene.ts'), { name: 'replay_scene.ts', declaredPath: 'backend/replay_scene.ts' })
  assert.equal(plannedFilename({ name: 'Synthetic scenes', declaredPath: 'backend\\fixtures\\scenes.json' }), 'scenes.json')
})

test('filename-shaped names stay in sync and files without a path keep a usable identity', () => {
  assert.equal(plannedFilename({ name: 'replay.py' }), 'replay.py')
  assert.deepEqual(renamePlannedFile({ name: 'replay.py', declaredPath: 'backend/replay.py' }, 'new.py'), { name: 'new.py', declaredPath: 'backend/new.py' })
  assert.deepEqual(renamePlannedFile({ name: 'backend/replay.py' }, 'new.py'), { name: 'new.py', declaredPath: 'backend/new.py' })
})

test('legacy agent plans expose the same filename, inferred language and description everywhere', () => {
  const node = { name: 'Synthetic Replay Scenes', declaredPath: 'backend/tests/scenes.json', notes: 'Synthetic scenes for offline replay.' }
  assert.deepEqual(plannedFileProperties(node, {}), { filename: 'scenes.json', language: 'json', description: node.notes })
  assert.equal(plannedFileProperties(node, { description: '' }).description, '', 'clearing a description must not resurrect old notes')
  assert.equal(plannedFileProperties(node, { description: 'New description' }).description, 'New description')
  assert.equal(plannedFileProperties(node, { language: 'python' }).language, 'json', 'the real filename takes precedence over stale language metadata')
})

test('explicit member edits including an empty list take precedence over legacy members', () => {
  const legacy = [{ signature: 'evaluate_scene' }]
  assert.equal(plannedFileSymbols({}, legacy)[0].name, 'evaluate_scene')
  assert.deepEqual(plannedFileSymbols({ symbols: [] }, legacy), [])
  const members = [{ name: 'evaluate', kind: 'function' }, { name: 'threshold', kind: 'variable' }, { name: 'Scene', kind: 'class' }]
  assert.deepEqual(plannedFileSymbols({ symbols: members }).map(({ name, kind }) => ({ name, kind })), members)
})

test('cards and Properties classify member kinds identically', () => {
  assert.equal(fileSymbolTab('Method'), 'functions')
  assert.equal(fileSymbolTab('interface'), 'classes')
  assert.equal(fileSymbolTab('type'), 'classes')
  assert.equal(fileSymbolTab('variable'), 'variables')
  assert.equal(fileSymbolTab('unknown'), 'variables')
})

test('proposed systems use legacy notes and preserve description edits and clearing', () => {
  const system = { kind: 'system', notes: 'Offline tools reuse the existing evaluator.' }
  assert.equal(plannedDescription(system, {}), system.notes)
  assert.equal(plannedDescription(system, { description: 'Updated system responsibility.' }), 'Updated system responsibility.')
  assert.equal(plannedDescription(system, { description: '' }), '')
  assert.equal(plannedDescription({}, {}), '')
})
