import assert from 'node:assert/strict'
import test from 'node:test'
import { minimapScene, minimapView } from './minimapGeometry.ts'

test('minimap resolves admitted marks through canonical absolute geometry, skipping hidden nodes', () => {
  const nodes = [
    { id: 'parent', hidden: true, data: {} },
    { id: 'file', type: 'file', data: {}, selected: true },
    { id: 'infra', type: 'infra', data: { color: '#123456' } },
    { id: 'pending', data: {} },
    ...Array.from({ length: 100000 }, (_, i) => ({ id: `off-${i}`, hidden: true, data: {} })),
  ]
  const calls = []
  const scene = minimapScene(nodes, id => {
    calls.push(id)
    return id === 'pending' ? undefined : { x: id === 'file' ? 120 : -40, y: 60, width: 100, height: 50 }
  })
  assert.deepEqual(calls, ['file', 'infra', 'pending'])
  assert.deepEqual(scene.bounds, { x: -40, y: 60, width: 260, height: 50 })
  assert.equal(scene.rects[0].selected, true)
  assert.equal(scene.rects[0].color, '#6C757D')
  assert.equal(scene.rects[1].color, '#123456')
  assert.equal(scene.rects.length, 2)
})

test('minimap fits nodes plus camera with upstream aspect ratio and five-unit padding', () => {
  const view = minimapView({ x: -100, y: -50, width: 200, height: 100 }, { x: 0, y: 0, width: 300, height: 200 })
  assert.deepEqual(view, { x: -112.5, y: -62.5, width: 425, height: 275, offset: 12.5 })
  assert.deepEqual(minimapView(null, { x: 50, y: 60, width: 160, height: 100 }),
    { x: 45, y: 55, width: 170, height: 110, offset: 5 })
})
