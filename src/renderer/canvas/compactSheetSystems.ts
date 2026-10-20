import type { DbSystem, DbFile, FloorLayout } from '../../shared/types'
import { packFrame } from './packing.ts'
import { FRAME_ITEM_GAP, frameContentInsets } from './frameGeometry.ts'

/** Reuse the normal packer for automatic proposals. Authored sheet frames
 * are excluded by the caller; no Floor geometry is mutated or saved. */
export function compactSheetSystems(systems: DbSystem[], files: DbFile[], layouts: FloorLayout[], automatic: Set<string>) {
  const byId = new Map(layouts.map(layout => [layout.nodeId, { ...layout }]))
  const systemById = new Map(systems.map(system => [system.id, { ...system }]))
  const fileById = new Map(files.map(file => [file.id, file]))
  const children = new Map<string, string[]>()
  for (const node of [...systems, ...files]) {
    const parent = byId.has(node.id) ? byId.get(node.id)!.parentNodeId : ('parentId' in node ? node.parentId : node.systemId)
    if (parent) children.set(parent, [...children.get(parent) ?? [], node.id])
  }
  const done = new Set<string>()
  const depthOf = (id: string) => {
    const seen = new Set<string>()
    let parent = systemById.get(id)?.parentId
    while (parent && !seen.has(parent)) { seen.add(parent); parent = systemById.get(parent)?.parentId }
    return seen.size
  }
  const compact = (id: string) => {
    if (done.has(id)) return
    done.add(id)
    const members = children.get(id) ?? []
    for (const child of members) if (automatic.has(child)) compact(child)
    if (!automatic.has(id) || members.length === 0) return
    const sizes = members.map(child => {
      const node = systemById.get(child) ?? fileById.get(child)
      const row = byId.get(child)
      const scale = row?.scale ?? 1
      return { id: child, width: (row?.width ?? node?.width ?? (systemById.has(child) ? 620 : 220)) * scale, height: (row?.height ?? node?.height ?? (systemById.has(child) ? 420 : 110)) * scale }
    })
    const packed = packFrame(sizes, { baseGap: FRAME_ITEM_GAP })
    const depth = depthOf(id)
    let insets = frameContentInsets(packed.height, depth)
    for (let round = 0; round < 4; round++) insets = frameContentInsets(Math.max(160, packed.height + insets.top + insets.bottom), depth)
    const system = systemById.get(id)!
    system.width = Math.max(260, packed.width + insets.left + insets.right)
    system.height = Math.max(160, packed.height + insets.top + insets.bottom)
    for (const child of members) {
      const position = packed.positions.get(child)!
      const node = systemById.get(child) ?? fileById.get(child)
      const previous = byId.get(child)
      byId.set(child, {
        workspaceId: system.workspaceId, nodeId: child, nodeType: systemById.has(child) ? 'system' : 'file',
        parentNodeId: id, parentNodeType: 'system', containmentKind: 'part_of',
        positionX: insets.left + position.x, positionY: insets.top + position.y,
        width: previous?.width ?? node?.width ?? 220, height: previous?.height ?? node?.height ?? 110,
        scale: previous?.scale ?? 1, interiorScale: previous?.interiorScale ?? 1, updatedAt: previous?.updatedAt ?? 0,
      })
    }
  }
  for (const id of automatic) compact(id)
  return { systems: [...systemById.values()], layouts: [...byId.values()] }
}
