import type { Node } from '@xyflow/react'
import type { FloorLayout } from '../../shared/types'
import { absoluteRects, nodeSize } from './folderAnchors.ts'

/**
 * "New Sheet from Selection": what is selected on the Floor becomes the new
 * sheet's members - systems, files and infrastructure alike - so a sheet can
 * start from what you are looking at. Agents do the same with
 * `edit_sheet create` and `members`. Planned nodes and anything the map no
 * longer has are left out; a file inside a selected system is kept, since you
 * picked it too.
 */
export type SheetMember = { fileId: string } | { systemId: string } | { infraId: string }
export type SheetMemberLayout = Omit<FloorLayout, 'workspaceId' | 'updatedAt'>

export function sheetSelectionLayouts(members: SheetMember[], nodes: readonly Node[]): SheetMemberLayout[] {
  if (!members.length) return []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const rects = absoluteRects(nodes)
  const selected = new Set(members.map(member => 'systemId' in member ? member.systemId
    : 'fileId' in member ? member.fileId : member.infraId))
  let minX = Infinity, minY = Infinity
  for (const id of selected) {
    const rect = rects.get(id)
    if (!rect) continue
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
  }

  const layouts: SheetMemberLayout[] = []
  for (const id of selected) {
    const node = byId.get(id)
    const rect = rects.get(id)
    if (!node || !rect) continue
    // A selected ancestor already carries its descendants. Retain their
    // parent-relative coordinates, including any intermediate system.
    let parent = byId.get(node.parentId ?? '')
    while (parent && !selected.has(parent.id) && parent.type === 'system') {
      parent = byId.get(parent.parentId ?? '')
    }
    const keepParent = Boolean(parent && selected.has(parent.id))
    const layout = layoutForSceneNode(node, byId.get(node.parentId ?? ''))
    layouts.push(keepParent ? layout : {
      ...layout, parentNodeId: null, parentNodeType: null, containmentKind: 'root',
      positionX: rect.x - minX, positionY: rect.y - minY,
      scale: Number(node.data.worldScale ?? layout.scale),
    })
  }
  return layouts
}

export function layoutForSceneNode(node: Node, parent: Node | undefined): SheetMemberLayout {
  const nodeType = node.data.umlKind === 'infra' || node.type === 'infra' ? 'infra'
    : node.type === 'system' || node.type === 'note' ? node.type : 'file'
  const parentNodeType = parent ? (parent.type === 'infra' || parent.data.umlKind === 'infra' ? 'infra' : 'system') : null
  const scale = Number(node.data.frameScale ?? 1)
  const worldScale = Number(node.data.worldScale ?? scale)
  const parentScale = parent ? worldScale / scale : 1
  const { width, height } = nodeSize(node)
  return {
    nodeId: node.id, nodeType, parentNodeId: parent?.id ?? null, parentNodeType,
    containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType === 'system' ? 'part_of' : 'root',
    positionX: node.position.x / parentScale, positionY: node.position.y / parentScale,
    width: width / worldScale, height: height / worldScale, scale,
    interiorScale: Number(node.data.interiorScale ?? 1),
  }
}

export function sheetMembersFor(
  ids: Iterable<string>,
  map: { systems: Array<{ id: string }>; files: Array<{ id: string }>; infraNodes: Array<{ id: string }> },
): SheetMember[] {
  const systems = new Set(map.systems.map(system => system.id))
  const files = new Set(map.files.map(file => file.id))
  const infra = new Set(map.infraNodes.map(node => node.id))
  const members: SheetMember[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (systems.has(id)) members.push({ systemId: id })
    else if (files.has(id)) members.push({ fileId: id })
    else if (infra.has(id)) members.push({ infraId: id })
  }
  // Keep the member list stable across selection order by grouping node kinds.
  const rank = (member: SheetMember) => ('systemId' in member ? 0 : 'fileId' in member ? 1 : 2)
  return members.sort((a, b) => rank(a) - rank(b))
}

/**
 * Everything on the Floor as sheet members: what sits at its top level
 * (systems, files and infrastructure). A member system brings its whole
 * contents, and members with no sheet position follow the Floor, so the
 * sheet opens as the Floor does and stays live.
 */
export function floorCopyMembers(map: {
  systems: Array<{ id: string; parentId?: string | null; source?: string }>
  files: Array<{ id: string }>
  infraNodes: Array<{ id: string }>
  floorLayouts: Array<{ nodeId: string; nodeType: string; parentNodeId: string | null }>
}): SheetMember[] {
  // Inferred (cluster) systems are not drawn; their files already sit at the top.
  const drawn = map.systems.filter(system => system.source !== 'cluster')
  const placed = new Set(map.floorLayouts.map(layout => layout.nodeId))
  const ids = [
    ...map.floorLayouts.filter(layout => layout.parentNodeId === null).map(layout => layout.nodeId),
    // Not saved yet, but at the top all the same.
    ...drawn.filter(system => !system.parentId && !placed.has(system.id)).map(system => system.id),
    ...map.infraNodes.filter(node => !placed.has(node.id)).map(node => node.id),
  ]
  return sheetMembersFor(ids, { systems: drawn, files: map.files, infraNodes: map.infraNodes })
}

/** "3 systems and 2 files" - what the dialog says it will put on the sheet. */
export function describeSheetMembers(members: SheetMember[]): string {
  const count = (kind: 'systemId' | 'fileId' | 'infraId') => members.filter(member => kind in member).length
  const parts = [
    [count('systemId'), 'system', 'systems'],
    [count('fileId'), 'file', 'files'],
    [count('infraId'), 'infrastructure node', 'infrastructure nodes'],
  ] as const
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  if (said.length === 0) return 'nothing'
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`
}
