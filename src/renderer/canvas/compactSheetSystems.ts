import type { GeometryFile } from './scene/sceneGeometry'
import type { DbSystem, DbFile, FloorLayout } from '../../shared/types'
import { packFrame } from './packing.ts'
import { FRAME_ITEM_GAP, frameContentInsets } from './frameGeometry.ts'
import type { PreparedFloorGeometry } from './scene/sceneGeometry'

/** Placement can compress an unplaced frame after packing it. Fit its contents
 * against the final tab band, preserving the frame's allocated outer rectangle. */
export function fitAutomaticSheetContents(prepared: PreparedFloorGeometry, automatic: ReadonlySet<string>, sourceLayouts: readonly FloorLayout[] = []): PreparedFloorGeometry {
  const steps = fitAutomaticSheetContentsSteps(prepared, automatic, sourceLayouts)
  for (;;) { const next = steps.next(); if (next.done) return next.value }
}

export function* fitAutomaticSheetContentsSteps(prepared: PreparedFloorGeometry, automatic: ReadonlySet<string>, sourceLayouts: readonly FloorLayout[] = []): Generator<void, PreparedFloorGeometry> {
  const descriptors: PreparedFloorGeometry['descriptors'] = []
  const byId = new Map<string, typeof descriptors[number]>()
  const children = new Map<string, typeof descriptors>()
  let work = 0
  // A new proposal can compress a live context frame even though that frame
  // is not itself an automatic proposal. Scaling its old child coordinates
  // toward zero also scales away their title clearance. Fit that whole content
  // subtree against the real body, without changing the live outer rectangle.
  if (!automatic.size && !prepared.resizedContainerIds?.size) return prepared
  const originalInteriors = new Map<string, number>()
  for (const row of sourceLayouts) {
    if (prepared.resizedContainerIds?.has(row.nodeId)) originalInteriors.set(row.nodeId, row.interiorScale ?? 1)
    if ((++work & 255) === 0) yield
  }
  const compressed = new Set<string>()
  for (const id of prepared.resizedContainerIds ?? []) {
    if ((prepared.geometryById.get(id)?.interiorScale ?? 1) < (originalInteriors.get(id) ?? 1)) compressed.add(id)
    if ((++work & 255) === 0) yield
  }
  if (!automatic.size && !compressed.size) return prepared
  for (const original of prepared.descriptors) {
    const descriptor = { ...original, geometry: { ...original.geometry } }
    descriptors.push(descriptor)
    byId.set(descriptor.id, descriptor)
    if (descriptor.parentId) {
      const siblings = children.get(descriptor.parentId) ?? []
      siblings.push(descriptor)
      children.set(descriptor.parentId, siblings)
    }
    if ((++work & 255) === 0) yield
  }
  const geometryById = new Map(prepared.geometryById)
  const worldScaleById = new Map(prepared.worldScaleById)
  const contentScaleById = new Map(prepared.contentScaleById)
  // Prepared descriptors are in parent-before-child order.
  for (const descriptor of descriptors) {
    const frame = descriptor.geometry
    descriptor.worldScale = (byId.get(descriptor.parentId ?? '')?.contentScale ?? 1) * frame.scale
    const members = children.get(descriptor.id) ?? []
    if (compressed.has(descriptor.parentId ?? '')) compressed.add(descriptor.id)
    if ((automatic.has(descriptor.id) || compressed.has(descriptor.id)) && members.length > 0) {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
      for (const { geometry: child } of members) {
        left = Math.min(left, child.x); top = Math.min(top, child.y)
        right = Math.max(right, child.x + child.width * child.scale)
        bottom = Math.max(bottom, child.y + child.height * child.scale)
        if ((++work & 255) === 0) yield
      }
      const width = right - left, height = bottom - top
      const insets = frameContentInsets(frame.height, descriptor.depth, descriptor.worldScale)
      const scale = Math.min(frame.interiorScale, (frame.width - insets.left - insets.right) / width, (frame.height - insets.top - insets.bottom) / height)
      // A frame too small even for its chrome cannot expose usable content.
      // Keep its existing geometry rather than producing a negative transform.
      if (Number.isFinite(scale) && scale > 0) {
        frame.interiorScale = scale
        for (const member of members) {
          member.geometry.x = insets.left / scale + member.geometry.x - left
          member.geometry.y = insets.top / scale + member.geometry.y - top
          if ((++work & 255) === 0) yield
        }
      }
    }
    descriptor.contentScale = descriptor.worldScale * frame.interiorScale
    geometryById.set(descriptor.id, frame)
    worldScaleById.set(descriptor.id, descriptor.worldScale)
    contentScaleById.set(descriptor.id, descriptor.contentScale)
    if ((++work & 255) === 0) yield
  }
  return { ...prepared, descriptors, geometryById, worldScaleById, contentScaleById }
}

/** Reuse the normal packer for automatic proposals. Authored sheet frames
 * are excluded by the caller; no Floor geometry is mutated or saved. */
export function compactSheetSystems(systems: DbSystem[], files: DbFile[], layouts: FloorLayout[], automatic: Set<string>, notes: GeometryFile[] = []) {
  const byId = new Map(layouts.map(layout => [layout.nodeId, { ...layout }]))
  const systemById = new Map(systems.map(system => [system.id, { ...system }]))
  const fileById = new Map([...files, ...notes].map(file => [file.id, file]))
  const children = new Map<string, string[]>()
  for (const node of [...systems, ...files, ...notes]) {
    const parent = byId.has(node.id) ? byId.get(node.id)!.parentNodeId : ('parentId' in node ? node.parentId : node.systemId)
    if (parent) children.set(parent, [...children.get(parent) ?? [], node.id])
  }
  const done = new Set<string>()
  const parentOf = (id: string): string | null => byId.has(id)
    ? byId.get(id)!.parentNodeId
    : systemById.get(id)?.parentId ?? null
  const depthOf = (id: string) => {
    const seen = new Set<string>()
    let parent = parentOf(id)
    while (parent && !seen.has(parent)) { seen.add(parent); parent = parentOf(parent) }
    return seen.size
  }
  const worldScaleOf = (id: string) => {
    let scale = byId.get(id)?.scale ?? 1
    const seen = new Set([id])
    let parent = parentOf(id)
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const row = byId.get(parent)
      scale *= (row?.scale ?? 1) * (row?.interiorScale ?? 1)
      parent = parentOf(parent)
    }
    return Math.max(0.0001, scale)
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
    const interiorScale = Math.max(0.0001, byId.get(id)?.interiorScale ?? 1)
    const worldScale = worldScaleOf(id)
    // Child coordinates ride the interior transform; the frame's tab does not.
    // Reserve its actual rendered band before converting back to child space.
    let insets = frameContentInsets(packed.height * interiorScale, depth, worldScale)
    for (let round = 0; round < 24; round++) {
      const next = frameContentInsets(Math.max(160, packed.height * interiorScale + insets.top + insets.bottom), depth, worldScale)
      const settled = Math.abs(next.top - insets.top) < 1e-9
      insets = next
      if (settled) break
    }
    const system = systemById.get(id)!
    system.width = Math.max(260, packed.width * interiorScale + insets.left + insets.right)
    system.height = Math.max(160, packed.height * interiorScale + insets.top + insets.bottom)
    const ownLayout = byId.get(id)
    if (ownLayout) byId.set(id, { ...ownLayout, width: system.width, height: system.height })
    for (const child of members) {
      const position = packed.positions.get(child)!
      const node = systemById.get(child) ?? fileById.get(child)
      const previous = byId.get(child)
      byId.set(child, {
        workspaceId: system.workspaceId, nodeId: child, nodeType: child.startsWith('note:') ? 'note' : systemById.has(child) ? 'system' : 'file',
        parentNodeId: id, parentNodeType: 'system', containmentKind: 'part_of',
        positionX: insets.left / interiorScale + position.x, positionY: insets.top / interiorScale + position.y,
        width: previous?.width ?? node?.width ?? 220, height: previous?.height ?? node?.height ?? 110,
        scale: previous?.scale ?? 1, interiorScale: previous?.interiorScale ?? 1, updatedAt: previous?.updatedAt ?? 0,
      })
    }
  }
  for (const id of automatic) compact(id)
  return { systems: [...systemById.values()], layouts: [...byId.values()] }
}
