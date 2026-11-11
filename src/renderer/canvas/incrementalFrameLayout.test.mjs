import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canPersistGeneratedFrame,
  fitFrameAmongSiblings,
  growFrameToContainChildren,
  orderFramePlacementCandidates,
} from './incrementalFrameLayout.ts'

test('an unclassified file is not pinned to the root before classification settles', () => {
  assert.equal(canPersistGeneratedFrame('file', null), false)
  assert.equal(canPersistGeneratedFrame('file', 'services'), true)
  assert.equal(canPersistGeneratedFrame('system', null), true)
  assert.equal(canPersistGeneratedFrame('infra', null), true)
})

test('persisted siblings are registered before incoming nodes regardless of snapshot order', () => {
  const ordered = orderFramePlacementCandidates([
    { id: 'incoming-models', parentId: null, placementPriority: 2 },
    { id: 'persisted-services', parentId: null, placementPriority: 0 },
    { id: 'authored-root', parentId: null, placementPriority: 1 },
    { id: 'incoming-storage', parentId: null, placementPriority: 2 },
  ])

  assert.deepEqual(ordered.map(item => item.id), [
    'persisted-services',
    'authored-root',
    'incoming-models',
    'incoming-storage',
  ])
})

test('placement ordering remains local to each parent frame', () => {
  const ordered = orderFramePlacementCandidates([
    { id: 'new-service-file', parentId: 'services', placementPriority: 2 },
    { id: 'saved-model-file', parentId: 'models', placementPriority: 0 },
    { id: 'saved-service-file', parentId: 'services', placementPriority: 0 },
  ])

  assert.deepEqual(ordered.map(item => item.id), [
    'saved-model-file',
    'saved-service-file',
    'new-service-file',
  ])
})

test('a persisted frame only grows enough to contain a late child', () => {
  const frame = { x: 10, y: 20, width: 620, height: 420, scale: 1 }
  const result = growFrameToContainChildren(frame, [
    { x: 32, y: 90, width: 220, height: 110, scale: 1 },
    { x: 288, y: 90, width: 220, height: 110, scale: 1 },
    { x: 544, y: 90, width: 220, height: 110, scale: 1 },
  ], 32)

  assert.deepEqual(result, {
    x: 10,
    y: 20,
    width: 796,
    height: 420,
    scale: 1,
  })
})

test('existing authored dimensions never shrink', () => {
  const frame = { x: 10, y: 20, width: 900, height: 700, scale: 1 }
  const result = growFrameToContainChildren(frame, [
    { x: 32, y: 90, width: 220, height: 110, scale: 1 },
  ], 32)

  assert.deepEqual(result, frame)
})


const frameAt = (x, y, width, height, interiorScale = 1) => ({ x, y, width, height, scale: 1, interiorScale })

test('a frame with room grows to take new children', () => {
  const frame = frameAt(0, 0, 300, 200)
  const children = [frameAt(20, 40, 220, 110), frameAt(20, 170, 220, 110)]
  const fitted = fitFrameAmongSiblings(frame, children, 20, [frameAt(800, 0, 300, 200)], 24)
  assert.equal(fitted.height, 300)
  assert.equal(fitted.interiorScale, 1)
})

test('a frame hemmed in by a neighbour compresses its interior instead of overlapping it', () => {
  const frame = frameAt(0, 0, 300, 200)
  const children = [frameAt(20, 40, 220, 110), frameAt(20, 170, 220, 110)]
  const below = frameAt(0, 230, 300, 200)
  const fitted = fitFrameAmongSiblings(frame, children, 20, [below], 24)
  assert.equal(fitted.width, 300, 'the frame keeps its size')
  assert.equal(fitted.height, 200)
  assert.equal(fitted.x, 0)
  assert.ok(fitted.interiorScale < 1)
  assert.ok((170 + 110) * fitted.interiorScale + 20 <= 200 + 1e-9, 'every child fits inside the frame')
})

test('past the legibility floor the frame grows rather than shrink files to specks', () => {
  const frame = frameAt(0, 0, 300, 200)
  const children = Array.from({ length: 8 }, (_, i) => frameAt(20, 40 + i * 130, 220, 110))
  const fitted = fitFrameAmongSiblings(frame, children, 20, [frameAt(0, 230, 300, 200)], 24)
  assert.equal(fitted.interiorScale, 1)
  assert.ok(fitted.height > 200)
})

test('unplaced infrastructure forms a band below the map, stores first', async () => {
  const { placeInfraBand } = await import('./incrementalFrameLayout.ts')
  const systems = [{ x: 100, y: 100, width: 600, height: 400 }, { x: 740, y: 100, width: 600, height: 400 }]
  const band = placeInfraBand([
    { id: 'stripe', category: 'api', width: 260, height: 160 },
    { id: 'vercel', category: 'platform', width: 480, height: 300 },
    { id: 'pg', category: 'database', width: 260, height: 160 },
    { id: 'redis', category: 'cache', width: 260, height: 160 },
  ], systems, 40)
  const order = [...band.entries()].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x).map(([id]) => id)
  assert.deepEqual(order, ['pg', 'redis', 'stripe', 'vercel'])
  for (const position of band.values()) assert.ok(position.y >= 500 + 80, 'below every system')
  assert.equal(band.get('pg').x, 100, 'aligned with the map')
})

test('with nothing else on the Floor the band starts at the origin', async () => {
  const { placeInfraBand } = await import('./incrementalFrameLayout.ts')
  const band = placeInfraBand([{ id: 'pg', category: 'database', width: 260, height: 160 }], [], 40)
  assert.deepEqual(band.get('pg'), { x: 80, y: 80 })
})

test('a settled frame whose child outgrew it keeps its size and shrinks its contents around the first child', async () => {
  const { compressFrameToContainChildren } = await import('./incrementalFrameLayout.ts')
  // Asset Storage: Training Area Records grew past the bottom when a file was added.
  const frame = frameAt(0, 0, 832, 597.4)
  const children = [frameAt(12, 35, 476, 269.3), frameAt(500, 84, 320, 220), frameAt(12, 316.1, 320, 391.3), frameAt(344, 316.1, 320, 220)]
  const fitted = compressFrameToContainChildren(frame, children, 12)
  assert.ok(fitted)
  assert.equal(fitted.frame.width, 832, 'the frame keeps its size')
  assert.equal(fitted.frame.height, 597.4)
  assert.ok(fitted.frame.interiorScale < 1)
  const scale = fitted.frame.interiorScale
  // The first child is shown exactly where it was, so it stays clear of the title.
  assert.ok(Math.abs(fitted.children[0].x * scale - 12) < 1e-9 && Math.abs(fitted.children[0].y * scale - 35) < 1e-9)
  for (const child of fitted.children) {
    assert.ok((child.x + child.width) * scale <= 832 - 12 + 1e-9)
    assert.ok((child.y + child.height) * scale <= 597.4 - 12 + 1e-9, 'every child fits inside the frame')
  }
  // The arrangement is the same: distances between children only shrink.
  assert.ok(Math.abs((fitted.children[2].y - fitted.children[0].y) - (316.1 - 35)) < 1e-9)
})

test('a settled frame whose children fit is left alone', async () => {
  const { compressFrameToContainChildren } = await import('./incrementalFrameLayout.ts')
  assert.equal(compressFrameToContainChildren(frameAt(0, 0, 832, 597.4), [frameAt(12, 35, 476, 269.3), frameAt(12, 316.1, 320, 269.3)], 12), undefined)
  assert.equal(compressFrameToContainChildren(frameAt(0, 0, 300, 200, 0.5), [frameAt(12, 35, 400, 300)], 12), undefined, 'already compressed enough')
})
