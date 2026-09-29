import type { FrameGeometry } from './frameGeometry.ts'

export interface FramePlacementCandidate {
  id: string
  parentId: string | null
  /**
   * Persisted geometry must be registered before other authored positions,
   * and every authored position must be registered before an incoming node is
   * packed into the remaining space.
   */
  placementPriority: 0 | 1 | 2
}

export function canPersistGeneratedFrame(
  nodeType: 'system' | 'file' | 'infra',
  semanticParentId: string | null,
): boolean {
  return nodeType !== 'file' || semanticParentId !== null
}

/**
 * Produce a deterministic placement order without relying on API/database
 * insertion order. This is essential for incremental indexing: an incoming
 * node must see every persisted sibling as occupied even when that sibling
 * appears later in the semantic snapshot.
 */
export function orderFramePlacementCandidates<T extends FramePlacementCandidate>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const leftParent = left.parentId ?? ''
    const rightParent = right.parentId ?? ''
    return leftParent.localeCompare(rightParent) ||
      left.placementPriority - right.placementPriority ||
      left.id.localeCompare(right.id)
  })
}

/**
 * Containers keep their authored dimensions as a minimum, but grow when a
 * newly indexed child would otherwise be clipped or stacked outside them.
 * Existing children never cause a persisted frame to shrink or move.
 */
export function growFrameToContainChildren(
  frame: FrameGeometry,
  children: readonly FrameGeometry[],
  padding: number,
): FrameGeometry {
  // Children are authored in the frame's CONTENT space; the frame's own width
  // and height are in its own. A compressed interior genuinely occupies less of
  // the frame, so the child extents convert before they are compared.
  const interior = frame.interiorScale > 0 ? frame.interiorScale : 1
  let right = 0
  let bottom = 0
  for (const child of children) {
    right = Math.max(right, (child.x + child.width * child.scale) * interior)
    bottom = Math.max(bottom, (child.y + child.height * child.scale) * interior)
  }
  return {
    ...frame,
    width: Math.max(frame.width, right + padding),
    height: Math.max(frame.height, bottom + padding),
  }
}

export interface SiblingRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Below this a frame's contents stop being worth compressing: growing into a
 * neighbour is the lesser harm than files too small to read.
 */
export const LIVE_FIT_MIN_INTERIOR_SCALE = 0.4

/**
 * Make room for children that arrived live - an agent assigning a batch of
 * files to a system - without landing on the frame's neighbours.
 *
 * Growth is tried first, and kept when the grown frame still clears every
 * sibling. When it would not, the frame keeps its size and compresses its
 * interior instead, which the canvas contract defines as touching nothing
 * outside the frame. Siblings are never moved: their positions are authored.
 * Only when compression would pass the legibility floor does the frame grow
 * anyway.
 */
export function fitFrameAmongSiblings(
  frame: FrameGeometry,
  children: readonly FrameGeometry[],
  padding: number,
  siblings: readonly SiblingRect[],
  gap = 0,
): FrameGeometry {
  const grown = growFrameToContainChildren(frame, children, padding)
  if (grown.width === frame.width && grown.height === frame.height) return grown
  const scale = frame.scale > 0 ? frame.scale : 1
  const footprint = {
    x: grown.x - gap,
    y: grown.y - gap,
    width: grown.width * scale + gap * 2,
    height: grown.height * scale + gap * 2,
  }
  const collides = siblings.some(sibling =>
    footprint.x < sibling.x + sibling.width && sibling.x < footprint.x + footprint.width &&
    footprint.y < sibling.y + sibling.height && sibling.y < footprint.y + footprint.height)
  if (!collides) return grown

  // Children in content units; the frame shows them at interiorScale.
  let right = 0
  let bottom = 0
  for (const child of children) {
    right = Math.max(right, child.x + child.width * child.scale)
    bottom = Math.max(bottom, child.y + child.height * child.scale)
  }
  const fit = Math.min(
    frame.interiorScale > 0 ? frame.interiorScale : 1,
    right > 0 ? (frame.width - padding) / right : 1,
    bottom > 0 ? (frame.height - padding) / bottom : 1,
  )
  if (!(fit >= LIVE_FIT_MIN_INTERIOR_SCALE)) return grown
  return { ...frame, interiorScale: fit }
}

/**
 * Where infrastructure goes when nobody has placed it: a band below
 * everything else on the Floor, stores first, then messaging, external
 * services, and hosting last (INFRA_LAYER_PLAN.md L3). Code in the middle,
 * what it depends on underneath - the order is stable, so the band reads the
 * same in every project.
 */
export const INFRA_BAND_ORDER = [
  'database', 'cache', 'search', 'storage', 'queue', 'realtime', 'llm', 'api',
  'email', 'auth', 'flags', 'observability', 'scheduler', 'platform',
]

export function placeInfraBand(
  items: ReadonlyArray<{ id: string; category: string; width: number; height: number }>,
  occupied: readonly SiblingRect[],
  gap: number,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return out
  let left = 80
  let bottom = 80 - gap * 2
  let right = left
  if (occupied.length > 0) {
    left = Math.min(...occupied.map(rect => rect.x))
    bottom = Math.max(...occupied.map(rect => rect.y + rect.height))
    right = Math.max(...occupied.map(rect => rect.x + rect.width))
  }
  const rank = (category: string) => {
    const index = INFRA_BAND_ORDER.indexOf(category)
    return index < 0 ? INFRA_BAND_ORDER.length : index
  }
  const ordered = [...items].sort((a, b) => rank(a.category) - rank(b.category) || a.id.localeCompare(b.id))
  const rowWidth = Math.max(right - left, 4 * (260 + gap))
  let x = left
  let y = bottom + gap * 2
  let rowHeight = 0
  for (const item of ordered) {
    if (x > left && x + item.width > left + rowWidth) {
      x = left
      y += rowHeight + gap
      rowHeight = 0
    }
    out.set(item.id, { x, y })
    x += item.width + gap
    rowHeight = Math.max(rowHeight, item.height)
  }
  return out
}
