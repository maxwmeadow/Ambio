import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasScaleFixture } from '../../../tests/fixtures/canvasScale.ts'
test('scale fixtures preserve the exact local neighborhood as distant data grows', () => {
  const a = canvasScaleFixture({ entities: 1000, roots: 4 })
  const b = canvasScaleFixture({ entities: 10000, roots: 4 })
  assert.equal(a.systems.length + a.files.length, 1000)
  assert.equal(b.systems.length + b.files.length, 10000)
  assert.deepEqual(a.systems.slice(0,8), b.systems.slice(0,8))
  assert.deepEqual(a.files.slice(0,48), b.files.slice(0,48))
  assert.deepEqual(a.floorLayouts.slice(0,8), b.floorLayouts.slice(0,8))
  assert.equal(new Set(a.files.map(f=>f.rootId)).size, 4)
  assert.ok(a.floorLayouts.every(row => Number.isFinite(row.positionX) && row.interiorScale === 1))
})
test('deep/hub fixtures retain valid identities, parents, endpoint references and unsaved mode', () => {
  const snapshot = canvasScaleFixture({ entities: 1000, depth: 20, edges: 'hub', saved: false })
  const ids = new Set([...snapshot.systems, ...snapshot.files].map(n=>n.id))
  assert.equal(ids.size, 1000)
  assert.ok(snapshot.systems.some(s=>s.depth===19))
  assert.ok(snapshot.systems.every(s=>!s.parentId || ids.has(s.parentId)))
  assert.ok(snapshot.dependencies.every(e=>ids.has(e.src) && ids.has(e.dst)))
  assert.equal(snapshot.floorLayouts.length, 0)
  assert.throws(()=>canvasScaleFixture({entities:NaN}))
})
