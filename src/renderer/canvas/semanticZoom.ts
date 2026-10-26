import type { Node } from '@xyflow/react'

// A node reveals its contents once its on-screen geometric mean reaches this
// size. Keeping this size-relative makes semantic zoom independent of depth and
// of the world-space scale chosen by a layout.
export const REVEAL_CONTAINER_PX = 480

/** Marks a node that semantic zoom has hidden; see global.css. */
export const HIDDEN_NODE_CLASS = 'ambio-node-hidden'

// A leaf reveals its detail once its effective zoom (viewport zoom times the
// node's world scale) reaches this value. Nodes consume the resolved boolean
// rather than the raw zoom: stamping a continuously changing number onto every
// node gave every node a new identity on every animation frame of a zoom,
// forcing the whole canvas to re-render ~60 times a second.
export const DETAIL_REVEAL_EFFECTIVE_ZOOM = (0.95 + 1.2) / 2

interface VisibilityIndex {
  order: number[]
  thresholds: number[]
  appliedTier?: number
}
// A visibility pass changes presentation only. Carry the geometry index onto
// its result so easing frames between thresholds do no per-node work. A new
// scene array from editing/measurement invalidates it automatically.
const visibilityIndices = new WeakMap<Node[], VisibilityIndex>()

function visibilityTier(thresholds: number[], zoom: number): number {
  let lo = 0, hi = thresholds.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (zoom >= thresholds[mid]) lo = mid + 1
    else hi = mid
  }
  return lo
}

function sameVisibility(node: Node, next: {
  hidden: boolean
  opacity: number
  pointerEvents: 'all' | 'none'
  childrenVisible: number
  selfScale: number
  selfBlur: number
  detailRevealed: boolean
}): boolean {
  const style = node.style ?? {}
  const data = node.data as Record<string, unknown>
  const interactive = next.pointerEvents === 'all'
  return node.hidden === next.hidden &&
    style.opacity === next.opacity &&
    style.pointerEvents === next.pointerEvents &&
    style.transition === undefined &&
    node.draggable === interactive &&
    node.selectable === interactive &&
    (node.className ?? '') === (interactive ? '' : HIDDEN_NODE_CLASS) &&
    data.childrenVisible === next.childrenVisible &&
    data.selfScale === next.selfScale &&
    data.selfBlur === next.selfBlur &&
    data.detailRevealed === next.detailRevealed
}

export function applyZoomVisibility(nodes: Node[], zoom: number): Node[] {
  const steps = zoomVisibilitySteps(nodes, zoom)
  for (;;) { const result = steps.next(); if (result.done) return result.value }
}
export function* zoomVisibilitySteps(nodes: Node[], zoom: number): Generator<void, Node[]> {
  let work = 0
  let index = visibilityIndices.get(nodes)
  if (!index) {
    const thresholds = new Set<number>()
    for (const node of nodes) {
      if ((++work & 255) === 0) yield
      const w = Number(node.style?.width ?? node.measured?.width ?? 0)
      const h = Number(node.style?.height ?? node.measured?.height ?? 0)
      if (w > 0 && h > 0) thresholds.add(REVEAL_CONTAINER_PX / Math.sqrt(w * h))
      const scale = Number(node.data.worldScale ?? 1)
      if (scale > 0) thresholds.add(DETAIL_REVEAL_EFFECTIVE_ZOOM / scale)
    }
    index = {
      order: nodes.map((_, i) => i).sort((a, b) => Number(nodes[a].data.depth ?? 0) - Number(nodes[b].data.depth ?? 0)),
      thresholds: [...thresholds].sort((a, b) => a - b),
    }
    visibilityIndices.set(nodes, index)
  }
  const tier = visibilityTier(index.thresholds, zoom)
  if (index.appliedTier === tier) return nodes

  const childrenVisibleByNode = new Map<string, number>()
  let changed = false
  const updatedNodes = [...nodes]
  for (const position of index.order) {
    if ((++work & 255) === 0) yield
    const node = nodes[position]
    const selfVisibility = node.parentId
      ? (childrenVisibleByNode.get(node.parentId) ?? 0)
      : 1

    const worldWidth = Number(node.style?.width ?? node.measured?.width ?? 0)
    const worldHeight = Number(node.style?.height ?? node.measured?.height ?? 0)
    const measurable = worldWidth > 0 && worldHeight > 0
    const renderedSize = Math.sqrt(worldWidth * worldHeight) * zoom
    const childrenVisibility = selfVisibility
      * (!measurable || renderedSize >= REVEAL_CONTAINER_PX ? 1 : 0)

    childrenVisibleByNode.set(node.id, childrenVisibility)

    const next = {
      // React Flow uses `hidden` as a true render boundary: hidden nodes are
      // omitted from the DOM, viewport culling, and minimap. Opacity alone
      // left every descendant mounted and made a zoomed-out large project pay
      // the full layout/paint cost for hundreds of invisible file cards.
      hidden: selfVisibility <= 0.1,
      opacity: selfVisibility,
      pointerEvents: selfVisibility > 0.1 ? ('all' as const) : ('none' as const),
      childrenVisible: childrenVisibility,
      selfScale: 0.92 + 0.08 * selfVisibility,
      selfBlur: (1 - selfVisibility) * 3,
      detailRevealed:
        zoom * Number((node.data as Record<string, unknown>).worldScale ?? 1) >=
        DETAIL_REVEAL_EFFECTIVE_ZOOM,
    }
    // Referential stability is the whole point: React Flow re-renders a node
    // only when its object identity changes, so an untouched node must come
    // back as the exact same object.
    if (sameVisibility(node, next)) continue

    changed = true
    updatedNodes[position] = {
      ...node,
      hidden: next.hidden,
      // CSS alone cannot make a hidden node untouchable: `pointer-events: none`
      // on the wrapper is overridden by any descendant that sets `auto`, and
      // file nodes do for their editable chrome. So an invisible child stayed
      // grabbable and stole drags aimed at the container around it. React
      // Flow's own flags settle it above the DOM.
      draggable: next.pointerEvents === 'all',
      selectable: next.pointerEvents === 'all',
      // Descendants can re-enable pointer events on themselves, so the class
      // below kills them for the whole subtree. Without it a hidden node still
      // SWALLOWS the pointer: the click neither drags it nor reaches the
      // visible node beneath, and lands on whatever is behind instead.
      className: next.pointerEvents === 'all' ? '' : HIDDEN_NODE_CLASS,
      style: {
        ...node.style,
        opacity: next.opacity,
        pointerEvents: next.pointerEvents,
        // Deliberately no inline `transition`. An inline transition replaces
        // the whole property, which wiped the stylesheet's transform easing
        // and made nodes jump to new positions instead of gliding. The opacity
        // easing lives in global.css alongside the transform easing so every
        // node type animates identically.
        transition: undefined,
      },
      data: {
        ...node.data,
        childrenVisible: next.childrenVisible,
        selfScale: next.selfScale,
        selfBlur: next.selfBlur,
        detailRevealed: next.detailRevealed,
      },
    }
  }
  // A smooth zoom has many animation frames but only a handful of semantic
  // thresholds. Returning the input array between thresholds lets React and
  // React Flow bail out instead of reconciling the entire scene every frame.
  const result = changed ? updatedNodes : nodes
  visibilityIndices.set(result, { ...index, appliedTier: tier })
  return result
}

export function makeFullyVisible(node: Node): Node {
  const style = node.style ?? {}
  const data = node.data as Record<string, unknown>
  // Review deliberately keeps every node visible. Returning a fresh object for
  // an already-visible node defeated React Flow's per-node identity boundary,
  // so unrelated proposal responses could restamp the node component during a
  // resize even though none of its visible state changed.
  if (node.hidden === false &&
      node.draggable === true &&
      node.selectable === true &&
      (node.className ?? '') === '' &&
      style.opacity === 1 &&
      style.pointerEvents === 'all' &&
      data.selfScale === 1 &&
      data.selfBlur === 0 &&
      data.childrenVisible === 1) {
    return node
  }
  return {
    ...node,
    hidden: false,
    draggable: true,
    selectable: true,
    className: '',
    style: { ...node.style, opacity: 1, pointerEvents: 'all' as const },
    data: { ...node.data, selfScale: 1, selfBlur: 0, childrenVisible: 1 },
  }
}

/**
 * Explicit navigation (search, activity log, inspector links) may target a
 * node below the current semantic tier. Materialize only that node and its
 * ancestor path so React Flow can focus it without restoring every hidden
 * sibling to the DOM.
 */
export function revealNodePath(nodes: Node[], nodeId: string | null): Node[] {
  if (!nodeId) return nodes
  const target = nodes.find(node => node.id === nodeId)
  // A visible root has no hidden ancestry to resolve. Ordinary root selection
  // must not allocate a complete project index for this no-op.
  if (!target || (!target.parentId && !target.hidden)) return nodes
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (!byId.has(nodeId)) return nodes

  const path = new Set<string>()
  let currentId: string | undefined = nodeId
  while (currentId && !path.has(currentId)) {
    path.add(currentId)
    currentId = byId.get(currentId)?.parentId
  }

  let changed = false
  const revealed = nodes.map(node => {
    if (!path.has(node.id) || !node.hidden) return node
    changed = true
    return makeFullyVisible(node)
  })
  return changed ? revealed : nodes
}
