import assert from 'node:assert/strict'
import test from 'node:test'
import { getSmoothStepPath, Position } from '@xyflow/react'
import { clipOrthogonalEdge, orthogonalLength, orthogonalPoints } from './clippedEdgeGeometry.ts'

test('radius-zero SmoothStep routes remain straight and preserve their real arc length', () => {
  for (const sourcePosition of Object.values(Position)) for (const targetPosition of Object.values(Position)) {
    const [path] = getSmoothStepPath({ sourceX: -100, sourceY: -200, targetX: 1e6, targetY: 500,
      sourcePosition, targetPosition, borderRadius: 0, offset: 18 })
    const points = orthogonalPoints(path)
    assert.ok(points, path)
    assert.deepEqual(points[0], { x: -100, y: -200 })
    assert.deepEqual(points.at(-1), { x: 1e6, y: 500 })
    assert.ok(orthogonalLength(points) >= 1000800)
  }
  assert.equal(orthogonalPoints('M0 0L10 10'), null)
  assert.equal(orthogonalPoints('M0 0Q10 0 20 10'), null)
  assert.equal(orthogonalPoints('M0 0C1 2 3 4 5 6'), null)
  assert.equal(orthogonalPoints('M0 0L10 0Z'), null)
})

test('million-unit routes clip to the viewport and preserve dash phase and true target markers', () => {
  const points = [{ x: -1e6, y: 50 }, { x: 1e6, y: 50 }]
  assert.deepEqual(clipOrthogonalEdge(points, { x: 0, y: 0, width: 800, height: 600 }),
    [{ path: 'M0 50L800 50', startLength: 1e6, endsAtTarget: false }])
  assert.deepEqual(clipOrthogonalEdge([...points].reverse(), { x: 0, y: 0, width: 800, height: 600 }),
    [{ path: 'M800 50L0 50', startLength: 1e6 - 800, endsAtTarget: false }])
  assert.deepEqual(clipOrthogonalEdge([{ x: 50, y: -1e6 }, { x: 50, y: 100 }], { x: 0, y: 0, width: 800, height: 600 }),
    [{ path: 'M50 0L50 100', startLength: 1e6, endsAtTarget: true }])
  assert.deepEqual(clipOrthogonalEdge(points, { x: 0, y: 60, width: 800, height: 600 }), [])
})

test('routes that leave and re-enter retain distinct phases without drawing shortcuts', () => {
  const points = [{ x: -100, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 400 },
    { x: 200, y: 400 }, { x: 200, y: 50 }, { x: 220, y: 50 }]
  assert.deepEqual(clipOrthogonalEdge(points, { x: 0, y: 0, width: 256, height: 128 }), [
    { path: 'M0 50L100 50L100 128', startLength: 100, endsAtTarget: false },
    { path: 'M200 128L200 50L220 50', startLength: 922, endsAtTarget: true },
  ])
})
