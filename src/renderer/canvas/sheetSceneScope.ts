import type { Node } from '@xyflow/react'
import type { FloorModel } from './scene/usePreparedFloorGeometry'
import { absoluteRects } from './folderAnchors.ts'
import { layoutForSceneNode } from './sheetFromSelection.ts'

type SheetScene = Pick<FloorModel, 'systems' | 'files' | 'infraNodes' | 'dependencies' | 'layouts'>

/** Keep the live context referenced by visible sheets and the contents of its systems. */
export function scopeSheetScene(
  model: SheetScene,
  members: Iterable<string>,
  moves: ReadonlyMap<string, string | null>,
  floorNodes: readonly Node[],
  workspaceId: string,
): SheetScene {
  const ids = new Set(members)
  if (ids.size === 0) return { systems: [], files: [], infraNodes: [], dependencies: [], layouts: [] }
  const systemIds = new Set(model.systems.map(system => system.id))
  const layouts = new Map(model.layouts.map(layout => [layout.nodeId, layout]))
  const children = new Map<string, string[]>()
  const addChild = (id: string, parentId: string | null) => {
    if (!parentId || !systemIds.has(parentId)) return
    const siblings = children.get(parentId)
    if (siblings) siblings.push(id)
    else children.set(parentId, [id])
  }
  for (const system of model.systems) {
    addChild(system.id, system.parentId)
    addChild(system.id, layouts.get(system.id)?.parentNodeId ?? null)
  }
  for (const file of model.files) {
    addChild(file.id, file.systemId)
    addChild(file.id, layouts.get(file.id)?.parentNodeId ?? null)
  }
  // Set iteration also visits entries added while walking the descendants.
  for (const id of ids) {
    for (const child of children.get(id) ?? []) ids.add(child)
  }

  const floor = new Map(floorNodes.map(node => [node.id, node]))
  const scopedLayouts = []
  let rects: ReturnType<typeof absoluteRects> | undefined
  for (const id of ids) {
    const node = floor.get(id)
    let layout = layouts.get(id)
    if (!layout && node && !moves.has(id)) {
      layout = { ...layoutForSceneNode(node, floor.get(node.parentId ?? '')), workspaceId, updatedAt: 0 }
    }
    if (!layout) continue
    if (layout.parentNodeId && !ids.has(layout.parentNodeId)) {
      // A selected child can stand on its own. Translate its saved local
      // coordinates through the omitted Floor frame and retain its world size.
      const parent = floor.get(layout.parentNodeId)
      rects ??= absoluteRects(floorNodes)
      const origin = rects.get(layout.parentNodeId)
      const parentScale = Number(parent?.data.contentScale ?? parent?.data.worldScale ?? 1)
      layout = {
        ...layout, parentNodeId: null, parentNodeType: null, containmentKind: 'root',
        positionX: (origin?.x ?? 0) + layout.positionX * parentScale,
        positionY: (origin?.y ?? 0) + layout.positionY * parentScale,
        scale: layout.scale * parentScale,
      }
    }
    scopedLayouts.push(layout)
  }

  return {
    systems: model.systems.filter(system => ids.has(system.id)),
    files: model.files.filter(file => ids.has(file.id)),
    infraNodes: model.infraNodes.filter(infra => ids.has(infra.id)),
    dependencies: model.dependencies.filter(edge => ids.has(edge.src) && ids.has(edge.dst)),
    layouts: scopedLayouts,
  }
}
