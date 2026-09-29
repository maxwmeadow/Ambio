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
