import type { FloorLayout } from '../../shared/types'

const indexes = new WeakMap<FloorLayout[], Map<string, number>>()
const keyOf = (row: FloorLayout) => `${row.nodeType}:${row.nodeId}`
const geometryFields = ['workspaceId', 'nodeId', 'nodeType', 'parentNodeId', 'parentNodeType', 'containmentKind',
  'positionX', 'positionY', 'width', 'height', 'scale', 'interiorScale'] as const

/** A save echo is not a new layout. Backend timestamps stay authoritative in
 * SQLite; a timestamp-only echo must not repack the renderer's scene. */
export function mergeFloorLayoutUpdates(current: FloorLayout[], updates: readonly FloorLayout[]): FloorLayout[] {
  let index = indexes.get(current)
  if (!index) { index = new Map(current.map((row, i) => [keyOf(row), i])); indexes.set(current, index) }
  let next: FloorLayout[] | undefined, nextIndex: Map<string, number> | undefined
  for (const row of updates) {
    const key = keyOf(row), at = (nextIndex ?? index).get(key)
    const before = at === undefined ? undefined : (next ?? current)[at]
    if (before && geometryFields.every(field => Object.is(before[field], row[field]))) continue
    next ??= current.slice()
    if (at === undefined) {
      nextIndex ??= new Map(index); nextIndex.set(key, next.length); next.push(row)
    } else next[at] = row
  }
  if (!next) return current
  indexes.set(next, nextIndex ?? index)
  return next
}

/** Preserve both collection and entity identities for unchanged parent echoes. */
export function mergeLayoutParents<T extends { id: string; parentId?: string | null; systemId?: string | null }>(nodes: T[], layouts: ReadonlyMap<string, FloorLayout>, type: 'system' | 'file'): T[] {
  let next: T[] | undefined
  const field = type === 'system' ? 'parentId' : 'systemId'
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], layout = layouts.get(`${type}:${node.id}`)
    if (!layout || layout.containmentKind === 'hosted_by' || (node[field] ?? null) === layout.parentNodeId) continue
    next ??= nodes.slice(); next[i] = { ...node, [field]: layout.parentNodeId }
  }
  return next ?? nodes
}
