import type { Node } from '@xyflow/react'
import { rememberPresentationScene } from './scene/canonicalScene.ts'

/** These overlays never change spatial geometry or semantic visibility. Keep
 * both the immutable array and prepared indexes when there is no real change. */
function stampOverlay(nodes: Node[], value: (node: Node) => Node): Node[] {
  let next: Node[] | undefined
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const updated = value(node)
    if (updated !== node) next ??= nodes.slice(0, i)
    next?.push(updated)
  }
  return next ? rememberPresentationScene(nodes, next) : nodes
}

export function stampBooleanOverlay(nodes: Node[], key: 'sliced' | 'dimmed' | 'isTraced', active: (id: string) => boolean): Node[] {
  return stampOverlay(nodes, node => {
    const value = active(node.id)
    return Boolean(node.data[key]) === value ? node : { ...node, data: { ...node.data, [key]: value } }
  })
}

export function stampRuntimeOverlay(nodes: Node[], runtime: Record<string, unknown>): Node[] {
  return stampOverlay(nodes, node => {
    const value = runtime[node.id] ?? null
    return (node.data.runtime ?? null) === value ? node : { ...node, data: { ...node.data, runtime: value } }
  })
}
