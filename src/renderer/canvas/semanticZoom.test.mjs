import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HIDDEN_NODE_CLASS,
  REVEAL_CONTAINER_PX,
  applyZoomVisibility,
  makeFullyVisible,
  revealNodePath,
  zoomVisibilitySteps,
} from './semanticZoom.ts'
import { stampSelection } from './selectionController.ts'
import { stampRuntimeOverlay } from './nodeOverlays.ts'

test('selection and activity retain semantic indexes without retaining stale geometry edits', () => {
  const original = applyZoomVisibility([
    node('root', 480, 480), node('child', 20, 20, { depth: 1, parentId: 'root' }),
  ], .5)
  const selected = stampSelection(original, new Set(['root']))
  const active = stampRuntimeOverlay(selected, { root: { status: 'running' } })
  let reads = 0
  for (const subject of active) {
    const style = subject.style
    Object.defineProperty(subject, 'style', { get() { reads++; return style } })
  }
  assert.equal(applyZoomVisibility(active, .51), active)
  assert.equal(reads, 0)
  const revealed = applyZoomVisibility(active, 1)
  assert.equal(revealed[1].hidden, false)
  assert.equal(revealed[0].selected, true)
  assert.deepEqual(revealed[0].data.runtime, { status: 'running' })
  const resized = revealed.map(n => n.id === 'root' ? { ...n, style: { width: 20, height: 20 } } : n)
  assert.equal(applyZoomVisibility(resized, 1)[1].hidden, true)
})

test('semantic indexing checkpoints its sort and preserves stable depth order', () => {
  const nodes = Array.from({ length: 2000 }, (_, i) => node(String(i), 480 + i, 480, {
    depth: 2000 - i, parentId: i < 1999 ? String(i + 1) : undefined,
  }))
  const steps = zoomVisibilitySteps(nodes, 2)
  let checkpoints = 0, result
  do { result = steps.next(); if (!result.done) checkpoints++ } while (!result.done)
  assert.ok(checkpoints > 30, `index/sort/visibility checkpoints: ${checkpoints}`)
  assert.deepEqual(result.value.map(n => n.id), nodes.map(n => n.id))
  assert.equal(result.value.every(n => !n.hidden), true)

  // Interrupt after the geometry scan, during the cooperative sorting stage.
  // An incomplete index must not be published onto the input array.
  let reads = 0
  const pending = nodes.map(n => {
    const data = n.data
    return { ...n, get data() { reads++; return data } }
  })
  const abandoned = zoomVisibilitySteps(pending, 2)
  for (let i = 0; i < 10; i++) assert.equal(abandoned.next().done, false)
  abandoned.return()
  reads = 0
  assert.equal(applyZoomVisibility(pending, 2).every(n => !n.hidden), true)
  assert.ok(reads >= pending.length)
})

const node = (id, width, height, options = {}) => ({
  id,
  position: { x: 0, y: 0 },
  style: { width, height },
  data: { depth: options.depth ?? 0 },
  ...(options.parentId ? { parentId: options.parentId } : {}),
})

test('contents reveal at the rendered geometric-mean threshold', () => {
  const subject = node('root', 120, 480)
  const below = applyZoomVisibility([subject], REVEAL_CONTAINER_PX / 240 - 0.001)[0]
  const atThreshold = applyZoomVisibility([subject], REVEAL_CONTAINER_PX / 240)[0]

  assert.equal(below.data.childrenVisible, 0)
  assert.equal(atThreshold.data.childrenVisible, 1)
})

test('cached visibility responds to reverse zoom, geometry edits and reparenting', () => {
  const initial = [node('root', 480, 480), node('leaf', 20, 20, { depth: 1, parentId: 'root' })]
  const small = applyZoomVisibility(initial, 0.5)
  const large = applyZoomVisibility(small, 1)
  assert.equal(large[1].hidden, false)
  assert.equal(applyZoomVisibility(large, 0.5)[1].hidden, true)
  const resized = large.map(n => n.id === 'root' ? { ...n, style: { width: 100, height: 100 } } : n)
  assert.equal(applyZoomVisibility(resized, 1)[1].hidden, true)
  const moved = small.map(n => n.id === 'leaf' ? { ...n, parentId: undefined } : n)
  assert.equal(applyZoomVisibility(moved, 0.5)[1].hidden, false)
})

test('cached easing frames do not read node geometry between thresholds', () => {
  const resolved = applyZoomVisibility([node('root', 480, 480)], 0.5)
  const original = resolved[0].style
  // Getter acts as a work counter, without a machine-dependent timing assertion.
  let reads = 0
  Object.defineProperty(resolved[0], 'style', { get() { reads++; return original } })
  assert.equal(applyZoomVisibility(resolved, 0.51), resolved)
  assert.equal(reads, 0)
})

test('a child cannot become visible before its parent reveals children', () => {
  const parent = node('parent', 100, 100, { depth: 0 })
  const child = node('child', 10_000, 10_000, { depth: 1, parentId: 'parent' })
  const result = applyZoomVisibility([child, parent], 1)

  assert.equal(result[0].style.opacity, 0)
  assert.equal(result[0].hidden, true)
  assert.equal(result[0].style.pointerEvents, 'none')
  assert.equal(result[0].data.childrenVisible, 0)
})

test('visibility is computed parent-first without changing render order', () => {
  const child = node('child', 20, 20, { depth: 1, parentId: 'parent' })
  const parent = node('parent', REVEAL_CONTAINER_PX, REVEAL_CONTAINER_PX)
  const result = applyZoomVisibility([child, parent], 1)

  assert.deepEqual(result.map(item => item.id), ['child', 'parent'])
  assert.equal(result[0].style.opacity, 1)
})

test('makeFullyVisible overrides temporary semantic-zoom hiding', () => {
  const hidden = applyZoomVisibility([
    node('child', 20, 20, { depth: 1, parentId: 'missing' }),
  ], 1)[0]
  const visible = makeFullyVisible(hidden)

  assert.equal(visible.style.opacity, 1)
  assert.equal(visible.hidden, false)
  assert.equal(visible.style.pointerEvents, 'all')
  assert.equal(visible.data.selfScale, 1)
  assert.equal(visible.data.selfBlur, 0)
  assert.equal(visible.data.childrenVisible, 1)
  assert.equal(makeFullyVisible(visible), visible)
})

test('a zoom change that alters nothing reuses the exact same node objects', () => {
  // React Flow re-renders a node only when its object identity changes. During
  // smooth-zoom easing this runs every animation frame, so a node whose
  // visibility did not change must come back identical or the whole canvas
  // re-renders ~60 times a second.
  const nodes = [
    node('root', REVEAL_CONTAINER_PX, REVEAL_CONTAINER_PX),
    node('leaf', 220, 110, { depth: 1, parentId: 'root' }),
  ]
  const first = applyZoomVisibility(nodes, 1)
  const again = applyZoomVisibility(first, 1)
  assert.equal(again, first)
  assert.equal(again[0], first[0])
  assert.equal(again[1], first[1])

  // A tiny easing step that crosses no threshold must also change nothing.
  const nudged = applyZoomVisibility(first, 1.0001)
  assert.equal(nudged, first)
  assert.equal(nudged[0], first[0])
  assert.equal(nudged[1], first[1])
})

test('a zoomed-out large scene keeps only its semantic root in the render set', () => {
  const root = node('root', 2_000, 1_200)
  const files = Array.from({ length: 805 }, (_, index) =>
    node(`file-${index}`, 220, 110, { depth: 1, parentId: 'root' }))
  const projected = applyZoomVisibility([root, ...files], 0.06)

  assert.equal(projected.filter(item => !item.hidden).length, 1)
  assert.equal(projected[0].hidden, false)
  assert.equal(projected[1].hidden, true)

  // Panning or a tiny smooth-zoom step inside the same semantic tier must not
  // create a new 806-item controlled array.
  assert.equal(applyZoomVisibility(projected, 0.06001), projected)
})

test('explicit navigation reveals only the target path, not its hidden siblings', () => {
  const projected = applyZoomVisibility([
    node('root', 100, 100),
    node('system', 100, 100, { depth: 1, parentId: 'root' }),
    node('target', 20, 20, { depth: 2, parentId: 'system' }),
    node('sibling', 20, 20, { depth: 2, parentId: 'system' }),
  ], 0.05)
  const revealed = revealNodePath(projected, 'target')

  assert.equal(revealed.find(item => item.id === 'root').hidden, false)
  assert.equal(revealed.find(item => item.id === 'system').hidden, false)
  assert.equal(revealed.find(item => item.id === 'target').hidden, false)
  assert.equal(revealed.find(item => item.id === 'sibling').hidden, true)
})

test('crossing the detail threshold does produce new node objects', () => {
  const leaf = node('leaf', 220, 110, { depth: 0 })
  leaf.data.worldScale = 1
  const below = applyZoomVisibility([leaf], 1)
  const above = applyZoomVisibility(below, 2)

  assert.notEqual(above[0], below[0])
  assert.equal(below[0].data.detailRevealed, false)
  assert.equal(above[0].data.detailRevealed, true)
})

test('crossing the container reveal threshold produces new node objects', () => {
  const parent = node('parent', REVEAL_CONTAINER_PX, REVEAL_CONTAINER_PX)
  const child = node('child', 100, 100, { depth: 1, parentId: 'parent' })
  const revealed = applyZoomVisibility([parent, child], 1)
  const hidden = applyZoomVisibility(revealed, 0.2)

  assert.equal(revealed[1].style.opacity, 1)
  assert.equal(hidden[1].style.opacity, 0)
  assert.notEqual(hidden[1], revealed[1])
})

test('a semantically hidden node cannot be grabbed', () => {
  // CSS pointer-events on the wrapper is not enough: a descendant setting
  // `auto` re-enables hits, so an invisible child stole drags meant for the
  // container drawn around it.
  const parent = node('parent', 100, 100)
  const child = node('child', 40, 40, { depth: 1, parentId: 'parent' })
  const [hiddenParent, hiddenChild] = applyZoomVisibility([parent, child], 0.05)

  assert.equal(hiddenChild.style.opacity, 0)
  assert.equal(hiddenChild.hidden, true)
  assert.equal(hiddenChild.style.pointerEvents, 'none')
  assert.equal(hiddenChild.draggable, false)
  // And genuinely click-through, so the pointer reaches the visible node it
  // sits on top of rather than being swallowed.
  assert.equal(hiddenChild.className, HIDDEN_NODE_CLASS)
  assert.equal(hiddenParent.className, '')
  assert.equal(hiddenChild.selectable, false)
  // The visible container it sits inside stays fully interactive.
  assert.equal(hiddenParent.draggable, true)
  assert.equal(hiddenParent.selectable, true)

  // Revealing restores interaction.
  const revealed = applyZoomVisibility(
    [node('parent', REVEAL_CONTAINER_PX, REVEAL_CONTAINER_PX),
     node('child', 40, 40, { depth: 1, parentId: 'parent' })],
    1,
  )[1]
  assert.equal(revealed.draggable, true)
  assert.equal(revealed.hidden, false)

  // A dragged node is forced interactive even while faded.
  assert.equal(makeFullyVisible(hiddenChild).draggable, true)
})
