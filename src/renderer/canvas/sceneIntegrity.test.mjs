import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createFloorSceneInspector,
  inspectFloorScene,
  partitionCanvasNodeChanges,
  prepareFloorSceneIntegritySteps,
} from './sceneIntegrity.ts'
import { runSceneSteps } from './scene/sceneSteps.ts'
import { rememberPresentationScene } from './scene/canonicalScene.ts'

const node = (id, parentId, overrides = {}) => ({
  id,
  type: parentId ? 'file' : 'system',
  parentId,
  position: { x: 20, y: 30 },
  style: { width: 220, height: 110, opacity: 1 },
  initialWidth: 220,
  initialHeight: 110,
  data: {},
  ...overrides,
})

test('prepared integrity validates independent membership and survives only safe presentation stamps', async () => {
  const ids = new Set(['root', 'child']), inspect = createFloorSceneInspector()
  let reads = 0
  const child = node('child', 'root')
  Object.defineProperty(child, 'position', { get() { reads++; return { x: 20, y: 30 } } })
  const nodes = [node('root'), child]
  const result = await runSceneSteps(prepareFloorSceneIntegritySteps(nodes, ids.size, ids))
  assert.deepEqual(result, { valid: true, reason: null, nodeCount: 2, rootCount: 1, visibleRootCount: 1, invalidNodeIds: [] })
  const selected = rememberPresentationScene(nodes, [{ ...nodes[0], selected: true }, child])
  reads = 0
  assert.equal(inspect(selected, 2, ids), result)
  assert.equal(reads, 0)
  // Equal contents with a different model identity must still be checked.
  assert.deepEqual(inspect(selected, 2, new Set(ids)), result)
  assert.ok(reads > 0)
  assert.equal(inspect(selected, 2, new Set(['root', 'other'])).reason, 'canonical-mismatch')
  assert.equal(inspect([{ ...selected[0], position: { x: NaN, y: 1 } }, child], 2, ids).reason, 'invalid-geometry')
  assert.equal(inspect([{ ...selected[0], hidden: true }, child], 2, ids).reason, 'no-visible-root')
  assert.equal(inspect([node('root', 'child'), child], 2, ids).reason, 'no-root')
})

test('cooperative integrity checkpoints every full audit and cancellation cannot publish a partial result', async () => {
  let reads = 0
  const nodes = Array.from({ length: 3000 }, (_, i) => {
    const subject = node(String(i), i ? '0' : undefined)
    Object.defineProperty(subject, 'position', { get() { reads++; return { x: 20, y: 30 } } })
    return subject
  })
  const ids = new Set(nodes.map(n => n.id))
  const steps = prepareFloorSceneIntegritySteps(nodes, ids.size, ids)
  let checkpoints = 0, result
  do { result = steps.next(); if (!result.done) checkpoints++ } while (!result.done)
  assert.ok(checkpoints >= 30)
  assert.deepEqual(result.value, inspectFloorScene(nodes, ids.size, ids))
  const pending = [...nodes], abort = new AbortController(), preparation = prepareFloorSceneIntegritySteps(pending, ids.size, ids)
  function* cancel() { yield preparation.next(); abort.abort(); yield* preparation }
  await assert.rejects(runSceneSteps(cancel(), abort.signal), { name: 'AbortError' })
  reads = 0
  assert.equal(createFloorSceneInspector()(pending, ids.size, ids).valid, true)
  assert.ok(reads >= nodes.length)
  const wrong = await runSceneSteps(prepareFloorSceneIntegritySteps(nodes, ids.size, new Set([...ids].slice(1))))
  assert.equal(wrong.reason, 'canonical-mismatch')
})

test('incremental integrity preserves the full audit through presentation, geometry and structural changes', () => {
  const inspect = createFloorSceneInspector(), ids = new Set(['root', 'child'])
  const original = [node('root'), node('child', 'root')]
  const before = inspect(original, 2, ids)
  assert.equal(inspect(original.map(n => ({ ...n, selected: true })), 2, ids), before)
  for (const changed of [
    original.map(n => ({ ...n, hidden: true })),
    [node('root', 'child'), node('child', 'root')],
    [node('root', undefined, { position: { x: NaN, y: 0 } }), original[1]],
    [node('root', undefined, { initialHeight: 0 }), original[1]],
    [node('root', undefined, { style: { opacity: 0 } }), original[1]],
    [original[1], original[0]], original.slice(1), [], original,
  ]) assert.deepEqual(inspect(changed, 2, ids), inspectFloorScene(changed, 2, ids))
})

test('selection does not re-read unchanged node geometry during integrity validation', () => {
  const inspect = createFloorSceneInspector(), ids = new Set(['root', 'child'])
  let reads = 0
  const child = node('child', 'root')
  Object.defineProperty(child, 'position', { get: () => { reads++; return { x: 20, y: 30 } } })
  const original = [node('root'), child]
  inspect(original, 2, ids); reads = 0
  inspect([{ ...original[0], selected: true }, child], 2, ids)
  assert.equal(reads, 0)
})

test('rejects structural view changes while preserving interaction changes', () => {
  const changes = [
    { type: 'dimensions', id: 'root', dimensions: { width: 620, height: 420 } },
    { type: 'remove', id: 'root' },
    { type: 'select', id: 'file', selected: true },
    { type: 'replace', id: 'file', item: node('file', 'root') },
    { type: 'add', item: node('other', null) },
  ]

  const result = partitionCanvasNodeChanges(changes)
  assert.deepEqual(result.interaction.map(change => change.type), ['dimensions', 'select'])
  assert.deepEqual(
    result.rejectedStructural.map(change => change.type),
    ['remove', 'replace', 'add'],
  )
})

test('rejects an empty scene when canonical graph data is populated', () => {
  assert.deepEqual(inspectFloorScene([], 17), {
    valid: false,
    reason: 'empty',
    nodeCount: 0,
    rootCount: 0,
    visibleRootCount: 0,
    invalidNodeIds: [],
  })
})

test('accepts semantic-zoom-hidden descendants when a visible root remains', () => {
  const result = inspectFloorScene([
    node('root', null),
    node('file', 'root', {
      style: { width: 220, height: 110, opacity: 0, pointerEvents: 'none' },
    }),
  ], 2)

  assert.equal(result.valid, true)
  assert.equal(result.rootCount, 1)
  assert.equal(result.visibleRootCount, 1)
})

test('rejects a stale scene whose ids do not match the canonical graph', () => {
  const result = inspectFloorScene(
    [node('old-root', null)],
    1,
    new Set(['new-root']),
  )
  assert.equal(result.reason, 'canonical-mismatch')
})

test('rejects rootless, invisible-root, and non-finite projections', () => {
  assert.equal(
    inspectFloorScene([
      node('a', 'b'),
      node('b', 'a'),
    ], 2).reason,
    'no-root',
  )
  assert.equal(
    inspectFloorScene([
      node('root', null, { style: { width: 620, height: 420, opacity: 0 } }),
    ], 1).reason,
    'no-visible-root',
  )
  const invalid = inspectFloorScene([
    node('root', null),
    node('file', 'root', { position: { x: Number.NaN, y: 30 } }),
  ], 2)
  assert.equal(invalid.reason, 'invalid-geometry')
  assert.deepEqual(invalid.invalidNodeIds, ['file'])
})
