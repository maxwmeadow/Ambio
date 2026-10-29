import assert from 'node:assert/strict'
import test from 'node:test'
import { plannedFilename, renamePlannedFile } from './plannedFileIdentity.ts'

test('a planned file uses its declared basename while retaining its architectural name', () => {
  const node = { name: 'Scene Replay CLI', declaredPath: 'backend/replay_scene.py' }
  assert.equal(plannedFilename(node), 'replay_scene.py')
  assert.deepEqual(renamePlannedFile(node, 'replay.py'), { name: node.name, declaredPath: 'backend/replay.py' })
  assert.deepEqual(renamePlannedFile(node, 'backend/replay_scene.ts'), { name: node.name, declaredPath: 'backend/replay_scene.ts' })
  assert.equal(plannedFilename({ name: 'Synthetic scenes', declaredPath: 'backend\\fixtures\\scenes.json' }), 'scenes.json')
})

test('filename-shaped names stay in sync and files without a path keep a usable identity', () => {
  assert.equal(plannedFilename({ name: 'replay.py' }), 'replay.py')
  assert.deepEqual(renamePlannedFile({ name: 'replay.py', declaredPath: 'backend/replay.py' }, 'new.py'), { name: 'new.py', declaredPath: 'backend/new.py' })
  assert.deepEqual(renamePlannedFile({ name: 'backend/replay.py' }, 'new.py'), { name: 'backend/new.py', declaredPath: 'backend/new.py' })
})
