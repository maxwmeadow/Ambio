import type { Node } from '@xyflow/react'

export interface CanvasNodeChangeLike {
  type: string
  id?: string
}

export interface SceneIntegrity {
  valid: boolean
  reason: 'empty' | 'canonical-mismatch' | 'no-root' | 'no-visible-root' | 'invalid-geometry' | null
  nodeCount: number
  rootCount: number
  visibleRootCount: number
  invalidNodeIds: string[]
}

const STRUCTURAL_CHANGE_TYPES = new Set(['add', 'remove', 'replace'])

function finiteDimension(node: Node, axis: 'width' | 'height'): boolean {
  // Match React Flow's nodeHasDimensions contract. CSS style dimensions size
  // the DOM but do not make a freshly-adopted node initialized; initialWidth /
  // initialHeight keep it visible until (and unless) measurement arrives.
  const initialAxis = axis === 'width' ? 'initialWidth' : 'initialHeight'
  const value = Number(node.measured?.[axis] ?? node[axis] ?? node[initialAxis] ?? 0)
  return Number.isFinite(value) && value > 0
}

function visiblyProjected(node: Node): boolean {
  if (node.hidden) return false
  const opacity = Number(node.style?.opacity ?? 1)
  return !Number.isFinite(opacity) || opacity > 0.1
}

/**
 * Canonical Floor structure belongs to Ambio's graph/layout stores. React Flow
 * may report interaction changes, but its local add/remove/replace operations
 * must never mutate that canonical projection.
 */
export function partitionCanvasNodeChanges<T extends CanvasNodeChangeLike>(
  changes: readonly T[],
): { interaction: T[]; rejectedStructural: T[] } {
  const interaction: T[] = []
  const rejectedStructural: T[] = []
  for (const change of changes) {
    if (STRUCTURAL_CHANGE_TYPES.has(change.type)) rejectedStructural.push(change)
    else interaction.push(change)
  }
  return { interaction, rejectedStructural }
}

/**
 * A populated canonical graph must always yield finite geometry and at least
 * one visible root. Descendants may be hidden by semantic zoom; roots may not.
 */
export function inspectFloorScene(
  nodes: readonly Node[],
  canonicalNodeCount: number,
  canonicalNodeIds?: ReadonlySet<string>,
  sceneNodeIds?: Set<string>,
): SceneIntegrity {
  if (canonicalNodeCount <= 0) {
    return {
      valid: true,
      reason: null,
      nodeCount: nodes.length,
      rootCount: 0,
      visibleRootCount: 0,
      invalidNodeIds: [],
    }
  }
  if (nodes.length === 0) {
    return {
      valid: false,
      reason: 'empty',
      nodeCount: 0,
      rootCount: 0,
      visibleRootCount: 0,
      invalidNodeIds: [],
    }
  }

  const nodeIds = sceneNodeIds ?? new Set(nodes.map(node => node.id))
  if (canonicalNodeIds && (
    nodeIds.size !== canonicalNodeIds.size ||
    [...canonicalNodeIds].some(id => !nodeIds.has(id))
  )) {
    return {
      valid: false,
      reason: 'canonical-mismatch',
      nodeCount: nodes.length,
      rootCount: 0,
      visibleRootCount: 0,
      invalidNodeIds: [],
    }
  }
  const roots = nodes.filter(node => !node.parentId || !nodeIds.has(node.parentId))
  const visibleRoots = roots.filter(visiblyProjected)
  const invalidNodeIds = nodes
    .filter(node =>
      !Number.isFinite(node.position?.x) ||
      !Number.isFinite(node.position?.y) ||
      !finiteDimension(node, 'width') ||
      !finiteDimension(node, 'height'),
    )
    .map(node => node.id)

  const reason = roots.length === 0
    ? 'no-root'
    : visibleRoots.length === 0
      ? 'no-visible-root'
      : invalidNodeIds.length > 0
        ? 'invalid-geometry'
        : null
  return {
    valid: reason === null,
    reason,
    nodeCount: nodes.length,
    rootCount: roots.length,
    visibleRootCount: visibleRoots.length,
    invalidNodeIds,
  }
}

/** Validate changed immutable nodes, retaining the complete ID/geometry audit
 * for structural revisions. Selection/chrome updates must not allocate a new
 * project-wide ID set or re-read every unchanged box. */
export function createFloorSceneInspector() {
  let previous: { nodes: readonly Node[]; count: number; ids?: ReadonlySet<string>; nodeIds: Set<string>; result: SceneIntegrity } | undefined
  return (nodes: readonly Node[], count: number, ids?: ReadonlySet<string>): SceneIntegrity => {
    if (previous && count > 0 && nodes.length > 0 && previous.result.reason !== 'canonical-mismatch' && previous.nodeIds.size === nodes.length && count === previous.count && ids === previous.ids && nodes.length === previous.nodes.length) {
      let roots = previous.result.rootCount, visible = previous.result.visibleRootCount
      const invalid = new Set(previous.result.invalidNodeIds)
      let structural = false
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], before = previous.nodes[i]
        if (node === before) continue
        if (node.id !== before.id) { structural = true; break }
        const wasRoot = !before.parentId || !previous.nodeIds.has(before.parentId)
        const isRoot = !node.parentId || !previous.nodeIds.has(node.parentId)
        roots += Number(isRoot) - Number(wasRoot)
        visible += Number(isRoot && visiblyProjected(node)) - Number(wasRoot && visiblyProjected(before))
        const valid = Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y) && finiteDimension(node, 'width') && finiteDimension(node, 'height')
        if (valid) invalid.delete(node.id); else invalid.add(node.id)
      }
      if (!structural) {
        const old = previous.result
        const reason: SceneIntegrity['reason'] = old.reason === 'canonical-mismatch' ? old.reason
          : roots === 0 ? 'no-root' : visible === 0 ? 'no-visible-root' : invalid.size ? 'invalid-geometry' : null
        const result: SceneIntegrity = roots === old.rootCount && visible === old.visibleRootCount && reason === old.reason &&
          invalid.size === old.invalidNodeIds.length && old.invalidNodeIds.every(id => invalid.has(id)) ? old : {
            valid: reason === null, reason, nodeCount: nodes.length, rootCount: roots, visibleRootCount: visible,
            invalidNodeIds: invalid.size ? nodes.filter(node => invalid.has(node.id)).map(node => node.id) : [],
          }
        previous = { ...previous, nodes, result }
        return result
      }
    }
    const nodeIds = new Set(nodes.map(node => node.id))
    const result = inspectFloorScene(nodes, count, ids, nodeIds)
    previous = { nodes, count, ids, nodeIds, result }
    return result
  }
}
