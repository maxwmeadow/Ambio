import test from 'node:test'
import assert from 'node:assert/strict'
import { stampBooleanOverlay, stampRuntimeOverlay } from './nodeOverlays.ts'
import { stampSelection } from './selectionController.ts'
import { prepareCanonicalSceneSteps, preparedCanonicalScene } from './scene/canonicalScene.ts'
import { runSceneSteps } from './scene/sceneSteps.ts'

test('idle overlays preserve the adopted scene; activating and clearing only change affected nodes', async () => {
  const original = ['a', 'b'].map(id => ({ id, position: { x: 0, y: 0 }, data: {} }))
  const scene = await runSceneSteps(prepareCanonicalSceneSteps(original))
  for (const key of ['sliced', 'dimmed', 'isTraced']) {
    assert.equal(stampBooleanOverlay(original, key, () => false), original)
    const active = stampBooleanOverlay(original, key, id => id === 'a')
    assert.equal(active[1], original[1])
    assert.equal(active[0].data[key], true)
    assert.equal(stampBooleanOverlay(active, key, id => id === 'a'), active)
    const cleared = stampBooleanOverlay(active, key, () => false)
    assert.equal(cleared[0].data[key], false)
    const cached = preparedCanonicalScene(cleared)
    assert.equal(cached.rects, scene.rects)
    assert.equal(cached.records, scene.records)
    assert.equal(cached.byId.get('a'), cleared[0])
  }
  assert.equal(stampRuntimeOverlay(original, {}), original)
  const metrics = { calls: 5 }, active = stampRuntimeOverlay(original, { a: metrics })
  assert.equal(active[0].data.runtime, metrics)
  assert.equal(active[1], original[1])
  assert.equal(stampRuntimeOverlay(active, { a: metrics }), active)
  assert.equal(stampRuntimeOverlay(active, {})[0].data.runtime, null)
  const selected = stampSelection(active, new Set(['b']))
  assert.equal(preparedCanonicalScene(selected).byId.get('b').selected, true)
  assert.equal(preparedCanonicalScene(selected).records, scene.records)
  // A normal immutable geometry edit has no prepared cache and must be rebuilt.
  assert.equal(preparedCanonicalScene(selected.map(n => ({ ...n, position: { x: 20, y: 30 } }))), undefined)
})
