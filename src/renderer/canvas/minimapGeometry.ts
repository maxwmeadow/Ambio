import type { Node } from '@xyflow/react'

export interface MinimapRect { id: string; x: number; y: number; width: number; height: number; color: string; selected: boolean }
export interface MinimapBounds { x: number; y: number; width: number; height: number }

/** Project only admitted nodes. Hidden ancestors still supply absolute origins
 * through React Flow's canonical lookup; no per-entity subscriber is needed. */
export function minimapScene(nodes: readonly Node[], geometry: (id: string) => MinimapBounds | undefined) {
  const rects: MinimapRect[] = []
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const node of nodes) {
    if (node.hidden) continue
    const rect = geometry(node.id)
    if (!rect || !(rect.width > 0 && rect.height > 0)) continue
    const color = String(node.data.color || (node.type === 'file' ? '#6C757D' : node.type === 'infra' ? '#D4A843' : '#2a2e33'))
    rects.push({ id: node.id, ...rect, color, selected: Boolean(node.selected) })
    left = Math.min(left, rect.x); top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { rects, bounds: rects.length ? { x: left, y: top, width: right - left, height: bottom - top } : null }
}

/** Match the passive React Flow minimap's aspect ratio, padding and viewport mask. */
export function minimapView(bounds: MinimapBounds | null, viewport: MinimapBounds) {
  const left = Math.min(bounds?.x ?? viewport.x, viewport.x)
  const top = Math.min(bounds?.y ?? viewport.y, viewport.y)
  const right = Math.max(bounds ? bounds.x + bounds.width : viewport.x + viewport.width, viewport.x + viewport.width)
  const bottom = Math.max(bounds ? bounds.y + bounds.height : viewport.y + viewport.height, viewport.y + viewport.height)
  const scale = Math.max((right - left) / 160, (bottom - top) / 100, .0001)
  const offset = 5 * scale
  const x = left - (scale * 160 - (right - left)) / 2 - offset
  const y = top - (scale * 100 - (bottom - top)) / 2 - offset
  const width = scale * 160 + offset * 2, height = scale * 100 + offset * 2
  return { x, y, width, height, offset }
}
