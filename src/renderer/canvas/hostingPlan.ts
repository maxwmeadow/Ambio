import { FRAME_ITEM_GAP, FRAME_ROOT_GAP, frameContentInsets } from './frameGeometry.ts'
import { packFrame, placeIncoming } from './packing.ts'

/**
 * Hosting on the canvas (INFRA_LAYER_PLAN.md, "Canvas placement"): what runs
 * the code is a frame around the systems it runs, nested the way it really is
 * - the backend in a Docker image, on Fly. Detection says which folder each
 * host runs ("hosts" contents, with "via" naming the container a platform
 * builds from) and which files run on it (RUNS_ON / DEPLOYS_TO). This turns
 * that into containment, then into frame geometry. Pure, so it is tested
 * without a canvas.
 */

export interface HostingPlatform {
  id: string
  /** service, or service#instance for one of several (a Dockerfile each). */
  key: string
  name: string
  hosts: Array<{ dir: string; via?: string }>
}

export interface HostingInput {
  platforms: readonly HostingPlatform[]
  systems: ReadonlyArray<{ id: string; parentId?: string | null }>
  files: ReadonlyArray<{ id: string; relPath: string; systemId?: string | null }>
  /** RUNS_ON / DEPLOYS_TO relationships into platforms. */
  runsOn: ReadonlyArray<{ src: string; srcType: string; dst: string }>
}

export interface HostingPlan {
  /** Root system or container → the platform frame that holds it. */
  parentOf: Map<string, string>
}

/** Extra room inside a hosting frame, so nested frames read as layers. */
const HOST_MARGIN = 40

/** Share of a system's files that must sit in a host's folder for it to be hosted there. */
const MAJORITY = 0.6

export function planHosting(input: HostingInput): HostingPlan {
  const parentOf = new Map<string, string>()
  const systemParent = new Map(input.systems.map(system => [system.id, system.parentId ?? null]))
  const rootOf = (systemId: string): string => {
    let current = systemId
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parent = systemParent.get(current)
      if (!parent) return current
      current = parent
    }
    return current
  }
  const filesByRoot = new Map<string, string[]>()
  const rootOfFile = new Map<string, string>()
  for (const file of input.files) {
    if (!file.systemId || !systemParent.has(file.systemId)) continue
    const root = rootOf(file.systemId)
    rootOfFile.set(file.id, root)
    filesByRoot.set(root, [...(filesByRoot.get(root) ?? []), file.relPath])
  }
  const byKey = new Map(input.platforms.map(platform => [platform.key, platform]))

  // Claims: which host wants which root system, and how specifically.
  const claims = new Map<string, { platformId: string; specificity: number }>()
  const claim = (systemId: string, platformId: string, specificity: number) => {
    const current = claims.get(systemId)
    if (!current || specificity > current.specificity
      || (specificity === current.specificity && platformId < current.platformId)) {
      claims.set(systemId, { platformId, specificity })
    }
  }
  const inFolder = (relPath: string, dir: string) => dir === '.' || dir === '' || relPath.startsWith(dir.replace(/\/$/, '') + '/')

  // A platform that names the files it runs (vercel.json functions) is not
  // also claiming the whole project because its config sits at the root.
  const namesItsFiles = new Set(input.runsOn.map(edge => edge.dst))
  for (const platform of input.platforms) {
    for (const host of platform.hosts) {
      if ((host.dir === '.' || host.dir === '') && namesItsFiles.has(platform.id) && !host.via) continue
      const via = host.via ? byKey.get(host.via) : undefined
      if (via && via.id !== platform.id) {
        // The platform runs this folder through a container: the container
        // sits inside the platform, and the container holds the code.
        parentOf.set(via.id, platform.id)
        continue
      }
      const depth = host.dir === '.' || host.dir === '' ? 0 : host.dir.split('/').length
      for (const [root, paths] of filesByRoot) {
        const inside = paths.filter(relPath => inFolder(relPath, host.dir)).length
        if (paths.length > 0 && inside / paths.length >= MAJORITY) claim(root, platform.id, 10 + depth)
      }
    }
  }
  // A named file running on a platform is stronger evidence than a folder.
  for (const edge of input.runsOn) {
    const root = edge.srcType === 'system' ? rootOf(edge.src) : rootOfFile.get(edge.src)
    if (root && input.platforms.some(platform => platform.id === edge.dst)) claim(root, edge.dst, 100)
  }
  // A folder claimed at the root ("the whole app") only takes systems no
  // narrower host claimed; the claim logic already prefers depth.
  for (const [systemId, { platformId }] of claims) parentOf.set(systemId, platformId)

  // Never nest a frame inside itself.
  for (const [child] of parentOf) {
    const seen = new Set<string>([child])
    let current = parentOf.get(child)
    while (current) {
      if (seen.has(current)) { parentOf.delete(child); break }
      seen.add(current)
      current = parentOf.get(current)
    }
  }
  return { parentOf }
}

export interface HostedChild {
  id: string
  nodeType: 'system' | 'infra'
  /** Current top-left in world space. */
  worldX: number
  worldY: number
  width: number
  height: number
  scale: number
  interiorScale: number
}

export interface HostingLayoutRow {
  nodeId: string
  nodeType: 'system' | 'infra'
  parentNodeId: string | null
  parentNodeType: 'infra' | null
  containmentKind: 'root' | 'hosted_by'
  positionX: number
  positionY: number
  width: number
  height: number
  scale: number
  interiorScale: number
}

/**
 * Frame geometry for one outermost host and everything nested in it. Frames
 * are packed inside out; the outer frame appears where its contents already
 * were, unless that would cover something else on the map.
 */
export function arrangeHosting(
  rootFrameId: string,
  plan: HostingPlan,
  current: ReadonlyMap<string, HostedChild>,
  occupied: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): HostingLayoutRow[] {
  const childrenOf = new Map<string, string[]>()
  for (const [child, parent] of plan.parentOf) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
  const rows: HostingLayoutRow[] = []
  const sizes = new Map<string, { width: number; height: number }>()
  const worldOrigin = new Map<string, { x: number; y: number }>()

  const pack = (frameId: string, depth: number) => {
    const children = (childrenOf.get(frameId) ?? []).sort()
    for (const child of children) if (childrenOf.has(child)) pack(child, depth + 1)
    const items = children.map(child => {
      const size = sizes.get(child) ?? (current.has(child)
        ? { width: current.get(child)!.width * current.get(child)!.scale, height: current.get(child)!.height * current.get(child)!.scale }
        : { width: 320, height: 220 })
      return { id: child, ...size }
    })
    const packed = packFrame(items, { baseGap: FRAME_ITEM_GAP * 2 })
    let insets = frameContentInsets(420, depth)
    for (let round = 0; round < 4; round++) {
      insets = frameContentInsets(Math.max(220, packed.height + insets.top + insets.bottom), depth)
    }
    // Hosting frames get a margin beyond a system's packing so each layer of
    // nesting reads as its own boundary.
    // The frame's cut top-left corner and coloured edge need clearance too, or
    // a nested frame's corner and tab crowd into them.
    insets = {
      left: insets.left + HOST_MARGIN,
      right: insets.right + HOST_MARGIN,
      bottom: insets.bottom + HOST_MARGIN,
      top: insets.top + HOST_MARGIN / 2,
    }
    const width = Math.max(320, packed.width + insets.left + insets.right)
    const height = Math.max(220, packed.height + insets.top + insets.bottom)
    sizes.set(frameId, { width, height })
    // Where this frame's contents are now, to open the frame around them.
    const origins = children.map(child => worldOrigin.get(child) ?? (current.has(child)
      ? { x: current.get(child)!.worldX, y: current.get(child)!.worldY }
      : null)).filter((point): point is { x: number; y: number } => point !== null)
    if (origins.length > 0) {
      worldOrigin.set(frameId, {
        x: Math.min(...origins.map(point => point.x)) - insets.left,
        y: Math.min(...origins.map(point => point.y)) - insets.top,
      })
    }
    for (const child of children) {
      const position = packed.positions.get(child)!
      const known = current.get(child)
      rows.push({
        nodeId: child,
        nodeType: known?.nodeType ?? 'infra',
        parentNodeId: frameId,
        parentNodeType: 'infra',
        containmentKind: 'hosted_by',
        positionX: insets.left + position.x,
        positionY: insets.top + position.y,
        width: sizes.has(child) ? sizes.get(child)!.width : known?.width ?? 320,
        height: sizes.has(child) ? sizes.get(child)!.height : known?.height ?? 220,
        scale: sizes.has(child) ? 1 : known?.scale ?? 1,
        interiorScale: sizes.has(child) ? 1 : known?.interiorScale ?? 1,
      })
    }
  }
  pack(rootFrameId, 0)

  const size = sizes.get(rootFrameId)!
  const wanted = worldOrigin.get(rootFrameId) ?? { x: 80, y: 80 }
  const overlaps = occupied.some(rect =>
    wanted.x < rect.x + rect.width + FRAME_ROOT_GAP / 2 && wanted.x + size.width + FRAME_ROOT_GAP / 2 > rect.x
    && wanted.y < rect.y + rect.height + FRAME_ROOT_GAP / 2 && wanted.y + size.height + FRAME_ROOT_GAP / 2 > rect.y)
  const spot = overlaps
    ? placeIncoming({ id: rootFrameId, ...size }, occupied, { baseGap: FRAME_ROOT_GAP, origin: wanted })
    : wanted
  rows.push({
    nodeId: rootFrameId,
    nodeType: 'infra',
    parentNodeId: null,
    parentNodeType: null,
    containmentKind: 'root',
    positionX: spot.x,
    positionY: spot.y,
    width: size.width,
    height: size.height,
    scale: 1,
    interiorScale: 1,
  })
  return rows
}
