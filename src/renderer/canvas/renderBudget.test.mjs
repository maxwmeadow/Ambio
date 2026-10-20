import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSceneIndex, queryScene, cameraRect, contains, initialRootVisible } from './renderBudgetGeometry.ts'
import { createRenderBudgetStore } from './renderBudgetStore.ts'
import { virtualRowRange } from './virtualRows.ts'
import { createFrameWorkQueue } from './frameWorkQueue.ts'

const camera = { x: 0, y: 0, zoom: 1, width: 800, height: 600, moving: false }
const record = (id, x, y, extra = {}) => ({ id, x, y, width: 220, height: 110, hidden: false, detail: true, kind: 'file', ...extra })

test('initial worker latency cannot admit distant roots or semantic descendants', () => {
  assert.equal(initialRootVisible(record('near', 0, 0), camera), true)
  assert.equal(initialRootVisible(record('buffer', 900, 0), camera), true)
  assert.equal(initialRootVisible(record('far', 1e6, 0), camera), false)
  assert.equal(initialRootVisible(record('child', 0, 0, {parentId:'parent'}), camera), false)
  assert.equal(initialRootVisible(record('hidden', 0, 0, {hidden:true}), camera), false)
})
test('spatial query resolves nested geometry, buffers viewport edges and excludes semantic hiding', () => {
  const index = buildSceneIndex([record('child', 25, 30, { parentId: 'root' }), record('root', 100, 200),
    record('buffered', 900, 0), record('outside', 2000, 0), record('hidden', 0, 0, { hidden: true })])
  assert.equal(index.byId.get('child').rect.x, 125)
  assert.equal(index.byId.get('child').rect.y, 230)
  const result = queryScene(index, camera)
  assert.deepEqual(new Set(result.visible.map(r => r.id)), new Set(['root', 'child', 'buffered']))
  assert.equal(result.visible.find(r => r.id === 'buffered').tier, 1)
  assert.equal(contains(result.bounds, cameraRect(camera, 100)), true)
})
test('moving cameras request compact nodes; settled readable nodes request detail; tiny nodes stay silhouettes', () => {
  const index = buildSceneIndex([record('a', 0, 0)])
  assert.equal(queryScene(index, camera).visible[0].tier, 2)
  assert.equal(queryScene(index, { ...camera, moving: true }).visible[0].tier, 1)
  assert.equal(queryScene(index, { ...camera, zoom: .02 }).visible[0].tier, 0)
})
test('index safely handles cycles, missing parents and giant frames without unbounded grid expansion', () => {
  const index = buildSceneIndex([record('a', 0, 0, { parentId: 'b' }), record('b', 5, 5, { parentId: 'a' }),
    record('orphan', 0, 0, { parentId: 'missing' }), record('giant', -1e8, -1e8, { width: 2e8, height: 2e8 })])
  assert.equal(index.byId.size, 4)
  assert.ok(index.cells.size < 20)
  assert.ok(queryScene(index, { ...camera, zoom: .0001 }).visible.some(r => r.id === 'giant'))
})
test('admission enforces both time and count budgets and lets interaction supersede hover during flight', () => {
  const store = createRenderBudgetStore()
  store.configure(true)
  let now = 0, changes = 0
  store.subscribe('a', () => { now += 4; changes++ })
  store.desired([{ id: 'a', tier: 2 }, { id: 'b', tier: 2 }])
  assert.deepEqual(store.drain(6, 3, () => now), { count: 1, pending: 1 })
  store.motion(true)
  assert.deepEqual(store.drain(6, Infinity, () => 0), { count: 1, pending: 0 })
  assert.equal(store.tier('b'), 1)
  store.promote('b', false)
  assert.equal(store.tier('b'), 1)
  store.promote('b')
  assert.equal(store.tier('b'), 2)
  assert.equal(changes, 1)
  store.motion(false)
  store.desired(Array.from({ length: 50 }, (_, i) => ({ id: String(i), tier: 2 })))
  assert.equal(store.drain(6, Infinity, () => 0).count, 6)
})
test('virtual rows bound DOM work and retain correct offsets across large scrolls and empty lists', () => {
  const start = virtualRowRange(10_000, 0, 85)
  assert.equal(start.end, 9)
  const middle = virtualRowRange(10_000, 85000, 85)
  assert.equal(middle.start, 4996)
  assert.equal(middle.totalHeight, 170000)
  assert.ok(middle.end - middle.start <= 13)
  assert.deepEqual(virtualRowRange(0, 999, 10), { start: 0, end: 0, totalHeight: 0 })
})
test('background updates remain ordered across yields, are bounded, and clear stale generations', () => {
  let now = 0, next = 0
  const frames = new Map(), output = []
  const queue = createFrameWorkQueue({ schedule: run => { frames.set(++next, run); return next },
    cancel: id => frames.delete(id), now: () => now, budgetMs: 3, maxPending: 4 })
  for (let i = 0; i < 4; i++) assert.equal(queue.push(() => { output.push(i); now += 2 }), true)
  assert.equal(queue.push(() => {}), false)
  const run = () => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback() }
  run(); assert.deepEqual(output, [0, 1])
  run(); assert.deepEqual(output, [0, 1, 2, 3])
  queue.push(() => output.push('stale')); queue.clear()
  assert.equal(frames.size, 0)
})
