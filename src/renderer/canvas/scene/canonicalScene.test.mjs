import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalScene, materializedIds, canonicalBounds, canonicalInternalNode, canonicalChildStarts, registerCanvasScene, canvasScene, releaseCanvasScene } from './canonicalScene.ts'
import { sceneRecords } from '../renderBudgetGeometry.ts'

const node = (id, parentId, x, y) => ({ id, parentId, position: { x, y }, style: { width: 200, height: 100 }, data: {} })
test('different hook facades of one Flow provider share canonical geometry; nested providers remain isolated', () => {
  const scene = canonicalScene([], []), getState = () => ({})
  registerCanvasScene({ getState }, scene)
  assert.equal(canvasScene({ getState }), scene)
  assert.equal(canvasScene({ getState: () => ({}) }), undefined)
  releaseCanvasScene({ getState }, scene)
  assert.equal(canvasScene({ getState }), undefined)
})
test('canonical bounds and nested drop geometry survive eviction, independent of array order', () => {
  const nodes = [node('child', 'parent', 20, 30), node('parent', undefined, 1000, 2000), node('distant', undefined, 1e6, 0)]
  const scene = canonicalScene(nodes, sceneRecords(nodes))
  assert.deepEqual(materializedIds(scene, ['child'], []), ['parent', 'child'])
  assert.deepEqual(canonicalBounds(scene, ['child']), { x: 1020, y: 2030, width: 200, height: 100 })
  assert.deepEqual(canonicalInternalNode(scene, 'child').internals.positionAbsolute, { x: 1020, y: 2030 })
  assert.equal(canonicalBounds(scene).width, 999200)
  assert.equal(canonicalInternalNode(scene, 'deleted'), undefined)
  assert.deepEqual([...canonicalChildStarts(scene, 'parent')], [['child', { x: 20, y: 30 }]])
})
test('camera materialization visits the admitted neighborhood rather than 100k project entities', () => {
  const nodes = Array.from({ length: 100000 }, (_, i) => node(String(i), undefined, i * 1000, 0))
  const records = sceneRecords(nodes), scene = canonicalScene(nodes, records)
  let reads = 0
  const get = scene.byId.get.bind(scene.byId)
  scene.byId.get = id => { reads++; return get(id) }
  assert.deepEqual(materializedIds(scene, ['5', '6'], ['7']), ['5', '6', '7'])
  assert.ok(reads <= 6)
  const selected = nodes.map((n, i) => i === 5 ? { ...n, selected: true } : n)
  const next = canonicalScene(selected, records, scene)
  assert.equal(next.rects, scene.rects)
  assert.equal(next.byId.get('5').selected, true)
  assert.deepEqual(materializedIds(next, ['6'], [], ['5', 'deleted']), ['5', '6'])
})
