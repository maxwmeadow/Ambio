import assert from 'node:assert/strict'
import test from 'node:test'
import { createSheetRelationshipRouter, routeSheetRelationship, segmentCrossesRect, sheetRelationshipInk } from './sheetRelationshipGeometry.ts'
import { absoluteRects, folderTabOf } from '../folderAnchors.ts'

const file = (id, x, y, width = 220, height = 110, parentId) => ({ id, type: 'file', position: { x, y }, style: { width, height }, data: {}, parentId })
const clearRoute = (route, obstacles) => {
  assert.ok(route)
  assert.ok(route.points.length >= 2)
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i]
    assert.ok(a.x === b.x || a.y === b.y, 'route must stay orthogonal')
    for (const rect of obstacles) assert.equal(segmentCrossesRect(a, b, rect), false, `path crosses ${JSON.stringify(rect)}: ${route.path}`)
  }
}

test('the replay test-to-CLI relationship goes around fixtures and meets real card boundaries', () => {
  const nodes = [file('tests', 0, 122), file('fixtures', 0, 0), file('cli', 232, 0)]
  const rects = absoluteRects(nodes)
  const route = routeSheetRelationship('tests', 'cli', nodes)
  clearRoute(route, [...rects.values()])
  const tip = route.points.at(-1), target = rects.get('cli')
  assert.ok(tip.x === target.x || tip.x === target.x + target.width || tip.y === target.y || tip.y === target.y + target.height)
})

test('nested and compressed replay relationships preserve obstacle avoidance', () => {
  for (const scale of [0.01, 0.25, 1, 4]) {
    const context = { ...file('context', -20 * scale, -40 * scale, 500 * scale, 320 * scale), type: 'system', data: { name: 'Replay', depth: 0 } }
    const nodes = [context, file('tests', 20 * scale, 162 * scale, 220 * scale, 110 * scale, context.id),
      file('fixtures', 20 * scale, 40 * scale, 220 * scale, 110 * scale, context.id),
      file('cli', 252 * scale, 40 * scale, 220 * scale, 110 * scale, context.id)]
    clearRoute(routeSheetRelationship('tests', 'cli', nodes), [...absoluteRects(nodes)].filter(([id]) => id !== context.id).map(([, rect]) => rect))
  }
})

test('connections to folders land outside their title tab, with unrelated frames treated as obstacles', () => {
  const folder = { ...file('folder', 300, 0, 400, 240), type: 'system', data: { name: 'Evaluator', depth: 1, directChildCount: 2 } }
  const nodes = [file('source', 0, 0), folder, file('blocker', 230, -25, 40, 150)]
  const route = routeSheetRelationship('source', 'folder', nodes)
  clearRoute(route, [absoluteRects(nodes).get('blocker')])
  const tip = route.points.at(-1), tab = folderTabOf(folder)
  if (route.targetSide === 'top') {
    assert.equal(tip.y, tab.height)
    assert.ok(tip.x >= 300 + tab.exposedFrom)
  }
})

test('sheet ink and arrowheads keep their screen size at close and wide zoom', () => {
  const route = routeSheetRelationship('a', 'b', [file('a', 0, 0), file('b', 300, 0)])
  for (const zoom of [0.01, 0.25, 1, 4, 100]) {
    const ink = sheetRelationshipInk(route, zoom)
    assert.equal(ink.strokeWidth * zoom, 1.25)
    assert.equal(ink.interactionWidth * zoom, 10)
    assert.deepEqual(ink.dash.split(' ').map(value => Number(value) * zoom), [5, 4])
    const coords = ink.arrow.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi).map(Number)
    const xs = [coords[0], coords[2], coords[4]], ys = [coords[1], coords[3], coords[5]]
    assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) * zoom - 8) < 1e-6)
    assert.ok(Math.abs((Math.max(...ys) - Math.min(...ys)) * zoom - 7) < 1e-6)
  }
})

test('staggered walls use a clear multi-bend gutter instead of crossing cards', () => {
  const nodes = [file('source', 1, 1, 1, 1), file('target', 9, 9, 1, 1),
    file('left', -1, -1, 1, 13), file('right', 11, -1, 1, 13), file('top', -1, -1, 13, 1), file('bottom', -1, 11, 13, 1),
    file('a', 3, 0, 1, 8), file('b', 6, 3, 1, 8), file('c', 8, 0, 1, 8)]
  const route = routeSheetRelationship('source', 'target', nodes)
  clearRoute(route, [...absoluteRects(nodes).values()])
  assert.ok(route.points.length > 6)
})

test('zoom and selection reuse routes; moving a card invalidates them', () => {
  const router = createSheetRelationshipRouter()
  const nodes = [file('a', 0, 0), file('b', 300, 0)]
  const edge = { id: 'e', source: 'a', target: 'b' }
  const original = router([edge], nodes)[0].data.sheetRoute
  assert.equal(router([{ ...edge, selected: true }], nodes.map(node => ({ ...node, data: { currentZoom: 20 } })))[0].data.sheetRoute, original)
  assert.notEqual(router([edge], [nodes[0], { ...nodes[1], position: { x: 400, y: 0 } }])[0].data.sheetRoute, original)
  const hiddenMeasurements = nodes.map(node => ({ ...node, measured: { width: 0, height: 0 } }))
  const beforeResize = router([edge], hiddenMeasurements)[0].data.sheetRoute
  const resized = router([edge], [{ ...hiddenMeasurements[0], style: { width: 260, height: 110 } }, hiddenMeasurements[1]])[0].data.sheetRoute
  assert.notEqual(resized, beforeResize, 'temporary zero measurements must not hide a canonical size change')
  assert.equal(resized.points[0].x, 260)
})
