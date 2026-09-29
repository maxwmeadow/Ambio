import type { Node } from '@xyflow/react'
import type { FloorLayout } from '../../shared/types'
import type { StencilDef } from '../components/SheetPalette'
import { planCanvasDrop } from './dropPersistence.ts'
import { frameWorldContentRect, nodeContentScale, nodeDepth, nodeWorldRect } from './nodeGeometry.ts'
import type { Point } from './frameGeometry.ts'

/** Hit the innermost eligible frame, including systems planned on this Sheet. */
export function stencilTargetAt(point: Point, nodes: Node[], positions: ReadonlyMap<string, Point>, editableIds: ReadonlySet<string>): Node | null {
  return nodes.filter(node => {
    if (node.type !== 'system' || !editableIds.has(node.id)) return false
    const absolute = positions.get(node.id)
    if (!absolute) return false
    const box = nodeWorldRect(node, absolute)
    return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
  }).sort((a, b) => {
    const depth = nodeDepth(b) - nodeDepth(a)
    if (depth) return depth
    const area = (node: Node) => {
      const box = nodeWorldRect(node, positions.get(node.id)!)
      return box.width * box.height
    }
    return area(a) - area(b)
  })[0] ?? null
}

export function stencilStartInFrame(target: Node, absolute: Point): Point {
  const content = frameWorldContentRect(target, absolute)
  return { x: content.x, y: content.y }
}

/** Creation uses the same containment, collision and scale rules as a drag. */
export function planStencilPlacement(input: {
  id: string
  stencil: StencilDef
  point: Point
  target: Node | null
  nodes: Node[]
  positions: ReadonlyMap<string, Point>
  editableIds: ReadonlySet<string>
  workspaceId: string
  layouts: FloorLayout[]
  systemIds: Set<string>
  fileIds: Set<string>
  infraIds: Set<string>
}) {
  const { id, stencil, point, target } = input
  const system = stencil.kind === 'system'
  const infra = stencil.kind === 'infra'
  const width = system ? 620 : infra ? 260 : 220
  const height = system ? 420 : infra ? 160 : 110
  const worldScale = target ? nodeContentScale(target) : 1
  const newcomer: Node = {
    id, type: system ? 'system' : infra ? 'infra' : 'file',
    position: point, selected: true,
    data: { worldScale },
    style: { width: width * worldScale, height: height * worldScale },
  }
  const plan = planCanvasDrop({
    workspaceId: input.workspaceId, draggedNodeId: id, targetNodeId: target?.id ?? null,
    allNodes: [...input.nodes.map(node => ({ ...node, selected: false })), newcomer],
    absolutePositions: new Map([...input.positions, [id, point]]),
    editableNodeIds: new Set([...input.editableIds, id]),
    systemIds: new Set([...input.systemIds, ...(system ? [id] : [])]),
    fileIds: new Set([...input.fileIds, ...(!system && !infra ? [id] : [])]),
    infraIds: new Set([...input.infraIds, ...(infra ? [id] : [])]),
    floorLayouts: input.layouts,
  })
  const layout = plan.updates.find(update => update.nodeId === id)!
  return { plan, layout }
}
