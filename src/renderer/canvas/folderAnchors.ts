import type { Edge, Node } from '@xyflow/react'

import { DEPTH_TITLE_PX } from './frameGeometry.ts'
import { chooseLivingAnchorPair, type LivingRect } from './livingEdgeGeometry.ts'
import { systemTabChrome } from './systemChrome.ts'

/**
 * Where a line may meet a node.
 *
 * A system draws as a folder: a tab across the top-left, the body below it.
 * The node's box starts at the top of the tab, so a line aimed at the box's
 * top edge ends in empty air above the body, or lands on the tab. Lines meet
 * the body instead: its top edge sits one tab height down, and the part of
 * that edge the tab covers is not a place to meet.
 */
export interface FolderTab {
  /** Tab height in the node's own pixels; the body's top edge. */
  height: number
  /** Where the body's exposed top edge begins, from the node's left. */
  exposedFrom: number
}

function positive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

export function nodeSize(node: Node): { width: number; height: number } {
  return {
    width: positive(node.measured?.width, node.width, node.style?.width) || 1,
    height: positive(node.measured?.height, node.height, node.style?.height) || 1,
  }
}

/**
 * The folder tab of a system node, from the same model SystemNode draws with.
 * Null for anything without one: files, infrastructure, and deployment
 * boundaries (a chassis, not a folder).
 */
export function folderTabOf(node: Node): FolderTab | null {
  if (node.type !== 'system') return null
  const d = node.data as Record<string, unknown>
  if (d.umlKind === 'infra') return null
  const { width, height } = nodeSize(node)
  const depthIdx = Math.min(Math.max(0, Number(d.depth ?? 0) || 0), DEPTH_TITLE_PX.length - 1)
  const presentationScale = positive(d.presentationScale) || 1
  const chrome = systemTabChrome({
    shellWidth: width,
    shellHeight: height,
    depthTitlePx: DEPTH_TITLE_PX[depthIdx],
    titlePx: DEPTH_TITLE_PX[depthIdx] * presentationScale,
    title: String(d.name ?? ''),
    count: Number(d.directChildCount ?? 0) || 0,
    frameStroke: 1,
  })
  return folderTabFromChrome(chrome.tabHeight, chrome.tabWidth, chrome.tabSlant, width)
}

/** Shared by SystemNode (exact chrome) and folderTabOf (reconstructed chrome). */
export function folderTabFromChrome(tabHeight: number, tabWidth: number, tabSlant: number, width: number): FolderTab {
  return {
    height: tabHeight,
    exposedFrom: Math.min(width, tabWidth + tabSlant),
  }
}

/**
 * Where a line meets the body's top edge: the middle of the part the tab
 * leaves exposed, so the line never crosses the tab to reach it.
 */
export function folderTopAnchorX(tab: FolderTab, width: number): number {
  return (tab.exposedFrom + width) / 2
}

/** Absolute world rects for every node, computed once for a whole scene. */
export function absoluteRects(nodes: readonly Node[]): Map<string, LivingRect> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const origin = new Map<string, { x: number; y: number } | null>()
  const originOf = (id: string, seen = new Set<string>()): { x: number; y: number } | null => {
    const cached = origin.get(id)
    if (cached !== undefined) return cached
    const node = byId.get(id)
    if (!node || seen.has(id)) return null
    seen.add(id)
    let at: { x: number; y: number } | null = { x: node.position?.x ?? 0, y: node.position?.y ?? 0 }
    if (node.parentId) {
      const parent = originOf(node.parentId, seen)
      at = parent ? { x: parent.x + at.x, y: parent.y + at.y } : null
    }
    origin.set(id, at)
    return at
  }
  const rects = new Map<string, LivingRect>()
  for (const node of nodes) {
    const at = originOf(node.id)
    if (!at) continue
    rects.set(node.id, { ...at, ...nodeSize(node) })
  }
  return rects
}

/** A system's body: its box without the tab strip. */
export function bodyRect(rect: LivingRect, tab: FolderTab | null): LivingRect {
  if (!tab) return rect
  const inset = Math.min(tab.height, rect.height * 0.5)
  return { x: rect.x, y: rect.y + inset, width: rect.width, height: rect.height - inset }
}

/**
 * Gives every edge the sides that face each other.
 *
 * Without a handle id React Flow uses the first handle a node declares, which
 * is `top` on every node here: every line left from and arrived at the top,
 * then detoured around both boxes. Edges that already name their handles
 * keep them, as do edges touching a node without named side handles.
 */
export function withFacingHandles(edges: Edge[], nodes: readonly Node[]): Edge[] {
  if (edges.length === 0) return edges
  const rects = absoluteRects(nodes)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const bodies = new Map<string, LivingRect>()
  const bodyOf = (id: string): LivingRect | null => {
    const hit = bodies.get(id)
    if (hit) return hit
    const rect = rects.get(id)
    const node = byId.get(id)
    // Only these declare the named side handles; anything else keeps its own.
    if (!rect || !node || !(node.type === 'system' || node.type === 'file')) return null
    const body = bodyRect(rect, folderTabOf(node))
    bodies.set(id, body)
    return body
  }
  let changed = false
  const next = edges.map(edge => {
    if (edge.sourceHandle || edge.targetHandle) return edge
    const source = bodyOf(edge.source)
    const target = bodyOf(edge.target)
    if (!source || !target) return edge
    const pair = chooseLivingAnchorPair(source, target)
    changed = true
    return { ...edge, sourceHandle: pair.sourceHandle, targetHandle: pair.targetHandle }
  })
  return changed ? next : edges
}
