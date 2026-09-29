import type { LivingRelationshipChange } from '../../shared/types.ts'
import type { NodeFx } from './sceneTypes.ts'

export function editNodeFxKind(
  exists: boolean,
  animate: boolean,
): NodeFx['kind'] | null {
  if (!exists) return 'enter'
  return animate ? 'edit' : null
}

export function relationshipVisual(
  event: Pick<LivingRelationshipChange, 'change'>,
): { color: string; targetKind: NodeFx['kind'] } {
  if (event.change === 'added') {
    return { color: '#2fa35d', targetKind: 'flow-add' }
  }
  if (event.change === 'removed') {
    return { color: '#b6534b', targetKind: 'flow-remove' }
  }
  return {
    color: '#3c8f92',
    targetKind: 'flow-update',
  }
}

/**
 * Relationship storage remains semantic (caller -> callee), while living
 * choreography is causal (edited file -> affected file). Legacy events and
 * rare graph-wide resolution changes whose origin is not an endpoint retain
 * their semantic direction.
 */
export function livingFlowEndpoints(
  event: Pick<LivingRelationshipChange, 'src' | 'dst' | 'originId'>,
): { source: string; target: string } {
  if (event.originId === event.dst) {
    return { source: event.dst, target: event.src }
  }
  return { source: event.src, target: event.dst }
}

/**
 * The words and ink for a node's activity, shared by the badge on a visible
 * file and the label a collapsed system shows for a file inside it, so the
 * same event reads the same wherever it surfaces.
 *
 * `enter` reads ADDED rather than CREATED: a file an agent builds waits in
 * Unsorted and only reaches the canvas when it is assigned, often well after
 * it was created.
 */
export function livingActivityLabel(kind: NodeFx['kind'] | undefined): string {
  switch (kind) {
    case 'enter': return 'ADDED'
    case 'edit': return 'EDITED'
    case 'exit': return 'DELETED'
    case 'classify': return 'MOVED'
    case 'flow-add': return 'LINK ADDED'
    case 'flow-remove': return 'LINK REMOVED'
    default: return 'IMPACT'
  }
}

export function livingActivityColor(kind: NodeFx['kind'] | undefined): string {
  if (kind === 'enter' || kind === 'flow-add' || kind === 'surface-add') return '#2fa35d'
  if (kind === 'exit' || kind === 'flow-remove' || kind === 'surface-remove') return '#b6534b'
  return '#3c8f92'
}
