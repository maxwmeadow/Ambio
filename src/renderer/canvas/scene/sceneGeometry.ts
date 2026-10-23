import type { DbSystem, DbFile, DbInfraNode, DbDependency, FloorLayout, FloorNodeType } from '../../../shared/types'
import { FRAME_ITEM_GAP, FRAME_ROOT_GAP, frameContentInsets, normalizeGeometry, type FrameGeometry } from '../frameGeometry.ts'
import { packFrame, placeIncoming } from '../packing.ts'
import { fitFrameAmongSiblings, orderFramePlacementCandidates, placeInfraBand } from '../incrementalFrameLayout.ts'
import { INFRA_CARD_SIZE, PLATFORM_FRAME_SIZE } from '../infraRoles.ts'
import type { FloorSceneDescriptor } from '../floorSceneProjection'

export type GeometrySystem = Pick<DbSystem, 'id' | 'parentId' | 'positionX' | 'positionY' | 'width' | 'height'>
export type GeometryFile = Pick<DbFile, 'id' | 'systemId' | 'positionX' | 'positionY' | 'width' | 'height'>
export type GeometryInfra = Pick<DbInfraNode, 'id' | 'category' | 'positionX' | 'positionY'>
export type GeometryDependency = Pick<DbDependency, 'src' | 'dst'>
export interface FloorGeometryInput {
  systems: GeometrySystem[]; files: GeometryFile[]; infraNodes: GeometryInfra[]
  dependencies: GeometryDependency[]; layouts: FloorLayout[]; placements: Map<string, GeneratedPlacement>
}
export function numericGeometryInput(systems: DbSystem[], files: DbFile[], infraNodes: DbInfraNode[], dependencies: DbDependency[], layouts: FloorLayout[], placements: Map<string, GeneratedPlacement>): FloorGeometryInput {
  const authored = new Set(layouts.filter(row => Number.isFinite(row.width) && row.width > 0 && Number.isFinite(row.height) && row.height > 0).map(row => row.nodeId))
  return {
    systems: systems.map(({ id, parentId, positionX, positionY, width, height }) => ({ id, parentId, positionX: authored.has(id) ? 0 : positionX, positionY: authored.has(id) ? 0 : positionY, width: authored.has(id) ? null : width, height: authored.has(id) ? null : height })),
    files: files.map(({ id, systemId, positionX, positionY, width, height }) => ({ id, systemId, positionX: authored.has(id) ? 0 : positionX, positionY: authored.has(id) ? 0 : positionY, width: authored.has(id) ? null : width, height: authored.has(id) ? null : height })),
    infraNodes: infraNodes.map(({ id, category, positionX, positionY }) => ({ id, category, positionX, positionY })),
    dependencies: layouts.length ? [] : dependencies.map(({ src, dst }) => ({ src, dst })), layouts, placements: new Map(placements),
  }
}

/**
 * Placements this session has already decided for nodes that have no persisted
 * row, keyed by node id.
 *
 * Without it the projection is NOT a pure function of persisted state: a
 * priority-2 node's position comes from `placeIncoming`, scored against the
 * live bounds and centroid of everything already registered in its frame. So
 * changing ONE node's geometry - any drop writes a row - shifts that centroid
 * and re-places every unpersisted sibling, which then shifts it again for the
 * next one. Dragging a single node made unrelated nodes scatter.
 *
 * Root-level unclassified files never persist at all (deliberately: pinning
 * them would block live classification from moving them into their system), so
 * for those the churn was permanent rather than transient.
 *
 * A remembered placement is dropped as soon as the node gains a persisted row
 * or moves to a different parent, so this only ever supplies the FIRST answer.
 */
export interface GeneratedPlacement { parentId: string | null; x: number; y: number }
export interface PreparedFloorGeometry {
  descriptors: FloorSceneDescriptor[]
  siblingsByParent: Map<string | null, string[]>
  geometryById: Map<string, FrameGeometry>
  worldScaleById: Map<string, number>
  contentScaleById: Map<string, number>
  generatedLayoutNodeIds: Set<string>
  resizedContainerIds: Set<string>
  generatedPlacements: Map<string, GeneratedPlacement>
}
export const BASE_FILE_W = 220   // cell width inside a depth-0 system
export const BASE_FILE_H = 110   // cell height inside a depth-0 system
const FILE_SCALE  = 2.0   // cell size halves each depth level

/** Cell (file node) size at a given depth. */
function fileNodeSize(depth: number): { w: number; h: number } {
  const s = Math.pow(FILE_SCALE, Math.max(0, depth))
  return {
    w: Math.max(80, Math.round(BASE_FILE_W / s)),
    h: Math.max(44, Math.round(BASE_FILE_H / s)),
  }
}

/** Uniform gap between / around every cell at depth. Also the header height. */
function gridGap(depth: number): number {
  return Math.floor(fileNodeSize(Math.max(0, depth)).h / 2)
}

/** Total container width for n columns at depth: n*cw + (n+1)*gap */
function containerW(n: number, depth: number): number {
  const { w: cw } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return n * cw + (n + 1) * gap
}

/** Total container height for n rows at depth: n*ch + (n+1)*gap */
function containerH(n: number, depth: number): number {
  const { h: ch } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return n * ch + (n + 1) * gap
}

/** X position of column col inside a container at depth. */
function cellX(col: number, depth: number): number {
  const { w: cw } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return (col + 1) * gap + col * cw
}

/** Y position of row inside a container at depth. */
function cellY(row: number, depth: number): number {
  const { h: ch } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return (row + 1) * gap + row * ch
}

/** How many parent cells a child of naturalSize spans. */
function wUnitsFor(naturalW: number, parentDepth: number): number {
  const { w: cw } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return Math.max(1, Math.ceil((naturalW + gap) / (cw + gap)))
}
function hUnitsFor(naturalH: number, parentDepth: number): number {
  const { h: ch } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return Math.max(1, Math.ceil((naturalH + gap) / (ch + gap)))
}

function snappedW(wUnits: number, parentDepth: number): number {
  const { w: cw } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return wUnits * (cw + gap) - gap
}
function snappedH(hUnits: number, parentDepth: number): number {
  const { h: ch } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return hUnits * (ch + gap) - gap
}

// ─── Alternate Axis Layout Algorithm ──────────────────────────────────────────

interface LayoutNodeResult {
  x: number
  y: number
  w: number
  h: number
}

export function completeGeometry<T>(steps: Generator<void, T, void>): T {
  for (;;) { const next = steps.next(); if (next.done) return next.value }
}

export function* runAlternateAxisLayoutSteps(
  systems: GeometrySystem[],
  files: GeometryFile[],
  infraNodes: GeometryInfra[],
  dependencies: GeometryDependency[],
  existingMap: Map<string, any>
): Generator<void, Map<string, LayoutNodeResult>, void> {
  let work = 0
  const systemsById = new Map(systems.map(s => [s.id, s]))
  const filesById = new Map(files.map(f => [f.id, f]))
  const infraById = new Map(infraNodes.map(i => [i.id, i]))
  const rootParentOf = new Map<string, string>()

  // Fill for systems
  for (const s of systems) {
    if ((++work & 255) === 0) yield
    let cur = s
    const visited = new Set<string>([cur.id])
    while (cur.parentId) {
      if ((++work & 255) === 0) yield
      const p = systemsById.get(cur.parentId)
      if (!p || visited.has(p.id)) break
      visited.add(p.id)
      cur = p
    }
    rootParentOf.set(s.id, cur.id)
  }

  // Fill for files
  for (const f of files) {
    if ((++work & 255) === 0) yield
    if (f.systemId) {
      const rootSysId = rootParentOf.get(f.systemId)
      if (rootSysId) {
        rootParentOf.set(f.id, rootSysId)
      }
    }
  }

  // Infra nodes map to themselves
  for (const inf of infraNodes) {
    if ((++work & 255) === 0) yield
    rootParentOf.set(inf.id, inf.id)
  }
  const parentMap = new Map<string, string>()
  for (const f of files) {
    if ((++work & 255) === 0) yield
    if (f.systemId) parentMap.set(f.id, f.systemId)
  }
  for (const s of systems) {
    if ((++work & 255) === 0) yield
    if (s.parentId) parentMap.set(s.id, s.parentId)
  }

  const childrenOf = new Map<string | null, GeometrySystem[]>()
  for (const sys of systems) {
    if ((++work & 255) === 0) yield
    const key = sys.parentId ?? null
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(sys)
  }

  const filesOf = new Map<string | null, GeometryFile[]>()
  for (const f of files) {
    if ((++work & 255) === 0) yield
    const key = f.systemId ?? null
    if (!filesOf.has(key)) filesOf.set(key, [])
    filesOf.get(key)!.push(f)
  }

  const computedPositions = new Map<string, LayoutNodeResult>()
  const computedSizes = new Map<string, { w: number; h: number }>()
  // An explicit seed map means positions are authoritative. Inferring this
  // from system-node metadata was brittle (sheet seeds and file-only sheets
  // legitimately have no typed system entry) and caused every composition to
  // rerun the root force layout.
  const isTidy = existingMap.size === 0

  const getSortKey = (id: string) => {
    const ext = existingMap.get(id)
    let x = 0, y = 0
    if (ext?.position?.x !== undefined && ext?.position?.y !== undefined) {
      x = ext.position.x
      y = ext.position.y
    } else {
      const sys = systemsById.get(id)
      if (sys?.positionX !== undefined && sys?.positionY !== undefined) {
        x = sys.positionX
        y = sys.positionY
      } else {
        const f = filesById.get(id)
        if (f?.positionX !== undefined && f?.positionY !== undefined) {
          x = f.positionX
          y = f.positionY
        } else {
          const inf = infraById.get(id)
          if (inf?.positionX !== undefined && inf?.positionY !== undefined) {
            x = inf.positionX
            y = inf.positionY
          }
        }
      }
    }
    return y * 10000 + x
  }

  function* layoutNode(systemId: string | null, depth: number): Generator<void, void, void> {
    let work = 0
    const childSystems = childrenOf.get(systemId) ?? []
    const childFiles   = filesOf.get(systemId) ?? []
    const childInfra   = systemId === null ? infraNodes : []

    // Bottom-up: layout children before the parent
    for (const cs of childSystems) yield* layoutNode(cs.id, depth + 1)

    // Empty system - minimum single-cell placeholder
    if (childSystems.length === 0 && childFiles.length === 0 && childInfra.length === 0) {
      if (systemId !== null) {
        const d = Math.max(0, depth)
        computedSizes.set(systemId, { w: containerW(1, d), h: containerH(1, d) })
      }
      return
    }

    if (systemId === null) {
      // Populate computedSizes for root files
      for (const f of childFiles) {
        if ((++work & 255) === 0) yield
        const fsz = fileNodeSize(0)
        computedSizes.set(f.id, { w: fsz.w, h: fsz.h })
      }

      // Root canvas: check if we should keep user-defined positions
      const rootItems = [
        ...childSystems.map(s => ({ id: s.id })),
        ...childFiles.map(f => ({ id: f.id })),
        ...childInfra.map(i => ({ id: i.id })),
      ]

      if (!isTidy) {
        // Keep existing/db positions
        for (const item of rootItems) {
          if ((++work & 255) === 0) yield
          const ext = existingMap.get(item.id)
          const sz = computedSizes.get(item.id) ?? { w: 400, h: 300 }
          let x = 0, y = 0
          if (ext?.position?.x !== undefined && ext?.position?.y !== undefined) {
            x = ext.position.x
            y = ext.position.y
          } else {
            const sys = systemsById.get(item.id)
            if (sys && (sys.positionX !== 0 || sys.positionY !== 0)) {
              x = sys.positionX
              y = sys.positionY
            } else {
              const file = filesById.get(item.id)
              if (file && (file.positionX !== 0 || file.positionY !== 0)) {
                x = file.positionX
                y = file.positionY
              } else {
                const inf = infraById.get(item.id)
                if (inf && (inf.positionX !== 0 || inf.positionY !== 0)) {
                  x = inf.positionX
                  y = inf.positionY
                }
              }
            }
          }
          computedPositions.set(item.id, { x, y, w: sz.w, h: sz.h })
        }
        return
      }

      // Tidy layout: arrange top-level nodes using force-directed layout + overlap resolution
      // Sort root items deterministically by static UUID to ensure consistent starting states without alphabetical bias
      rootItems.sort((a, b) => a.id.localeCompare(b.id))
      const rootIds = rootItems.map(item => item.id)
      const N = rootIds.length

      if (N === 1) {
        const id = rootIds[0]
        const sz = computedSizes.get(id) ?? { w: 400, h: 300 }
        computedPositions.set(id, { x: 0, y: 0, w: sz.w, h: sz.h })
        return
      }

      if (N > 1) {
        const positions = new Map<string, { x: number; y: number }>()

        // Initialize positions in a circle (always start from the circle for a clean, deterministic tidy)
        const radius = Math.max(400, N * 120)
        rootIds.forEach((id, idx) => {
          const angle = (2 * Math.PI * idx) / N
          const x = radius * Math.cos(angle)
          const y = radius * Math.sin(angle)
          positions.set(id, { x, y })
        })

        // Coupling weight matrix
        const weights = new Map<string, number>()
        const getWeight = (id1: string, id2: string) => {
          const key = id1 < id2 ? `${id1}::${id2}` : `${id2}::${id1}`
          return weights.get(key) ?? 0
        }
        for (const dep of dependencies) {
          if ((++work & 255) === 0) yield
          const rSrc = rootParentOf.get(dep.src)
          const rDst = rootParentOf.get(dep.dst)
          if (rSrc && rDst && rSrc !== rDst && rootIds.includes(rSrc) && rootIds.includes(rDst)) {
            const key = rSrc < rDst ? `${rSrc}::${rDst}` : `${rDst}::${rSrc}`
            weights.set(key, (weights.get(key) ?? 0) + 1)
          }
        }

        // Force simulation parameters
        const ITERATIONS = 200
        const K_REP = 1200000 // Repulsion force constant
        const K_ATT = 0.08    // Attraction spring constant
        const K_GRAV = 0.8 / N + 0.01 // Center gravity force (scales with node count)
        const cooling = 0.98  // Slower cooling rate for stable migration
        let temp = 150.0      // Annealing temperature starting value

        for (let step = 0; step < ITERATIONS; step++) {
          if ((++work & 255) === 0) yield
          const forces = new Map<string, { fx: number; fy: number }>()
          rootIds.forEach(id => forces.set(id, { fx: 0, fy: 0 }))

          // Repulsion
          for (let i = 0; i < N; i++) {
            if ((++work & 255) === 0) yield
            const idA = rootIds[i]
            const posA = positions.get(idA)!
            for (let j = i + 1; j < N; j++) {
              if ((++work & 255) === 0) yield
              const idB = rootIds[j]
              const posB = positions.get(idB)!
              const dx = posB.x - posA.x
              const dy = posB.y - posA.y
              const distSq = dx * dx + dy * dy
              const dist = Math.sqrt(distSq) || 0.1

              const force = K_REP / (distSq + 2000)
              const fx = (dx / dist) * force
              const fy = (dy / dist) * force

              forces.get(idA)!.fx -= fx
              forces.get(idA)!.fy -= fy
              forces.get(idB)!.fx += fx
              forces.get(idB)!.fy += fy
            }
          }

          // Attraction
          for (let i = 0; i < N; i++) {
            if ((++work & 255) === 0) yield
            const idA = rootIds[i]
            const posA = positions.get(idA)!
            for (let j = i + 1; j < N; j++) {
              if ((++work & 255) === 0) yield
              const idB = rootIds[j]
              const posB = positions.get(idB)!
              const w = getWeight(idA, idB)
              if (w > 0) {
                const dx = posB.x - posA.x
                const dy = posB.y - posA.y
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.1

                const wFactor = Math.min(6, w)
                const force = K_ATT * wFactor * dist
                const fx = (dx / dist) * force
                const fy = (dy / dist) * force

                forces.get(idA)!.fx += fx
                forces.get(idA)!.fy += fy
                forces.get(idB)!.fx -= fx
                forces.get(idB)!.fy -= fy
              }
            }
          }

          // Center gravity and move nodes
          rootIds.forEach(id => {
            const pos = positions.get(id)!
            const force = forces.get(id)!

            force.fx -= pos.x * K_GRAV
            force.fy -= pos.y * K_GRAV

            const fDist = Math.hypot(force.fx, force.fy) || 0.1
            const disp = Math.min(temp, fDist)
            pos.x += (force.fx / fDist) * disp
            pos.y += (force.fy / fDist) * disp
          })

          temp *= cooling
        }

        // Compact the settled cloud toward an even spread. Dependency chains
        // elongate the simulation into a strip; squeezing the long axis back
        // to the cloud's geometric-mean spread (never stretching the short
        // one) keeps neighborhoods intact while the overlap resolver below
        // re-spreads nodes isotropically into a boxy cluster.
        if (N > 2) {
          let meanX = 0, meanY = 0
          positions.forEach(pos => { meanX += pos.x; meanY += pos.y })
          meanX /= N
          meanY /= N
          let varX = 0, varY = 0
          positions.forEach(pos => {
            varX += (pos.x - meanX) ** 2
            varY += (pos.y - meanY) ** 2
          })
          const spreadX = Math.sqrt(varX / N)
          const spreadY = Math.sqrt(varY / N)
          if (spreadX > 1 && spreadY > 1) {
            const target = Math.sqrt(spreadX * spreadY)
            const squeezeX = Math.max(0.35, Math.min(1, target / spreadX))
            const squeezeY = Math.max(0.35, Math.min(1, target / spreadY))
            positions.forEach(pos => {
              pos.x = meanX + (pos.x - meanX) * squeezeX
              pos.y = meanY + (pos.y - meanY) * squeezeY
            })
          }
        }

        // Bounding-box overlap resolution
        const overlapPadding = BASE_FILE_W * 0.8
        for (let pass = 0; pass < 50; pass++) {
          if ((++work & 255) === 0) yield
          let resolvedAny = false
          for (let i = 0; i < N; i++) {
            if ((++work & 255) === 0) yield
            const idA = rootIds[i]
            const posA = positions.get(idA)!
            const szA = computedSizes.get(idA) ?? { w: 400, h: 300 }

            const wA = szA.w + overlapPadding
            const hA = szA.h + overlapPadding
            const cxA = posA.x + wA / 2
            const cyA = posA.y + hA / 2

            for (let j = i + 1; j < N; j++) {
              if ((++work & 255) === 0) yield
              const idB = rootIds[j]
              const posB = positions.get(idB)!
              const szB = computedSizes.get(idB) ?? { w: 400, h: 300 }

              const wB = szB.w + overlapPadding
              const hB = szB.h + overlapPadding
              const cxB = posB.x + wB / 2
              const cyB = posB.y + hB / 2

              const minDistanceX = (wA + wB) / 2
              const actualDistanceX = Math.abs(cxB - cxA)
              const overlapX = minDistanceX - actualDistanceX

              const minDistanceY = (hA + hB) / 2
              const actualDistanceY = Math.abs(cyB - cyA)
              const overlapY = minDistanceY - actualDistanceY

              if (overlapX > 0 && overlapY > 0) {
                resolvedAny = true
                if (overlapX < overlapY) {
                  const pushX = overlapX / 2
                  const dirX = cxB > cxA ? 1 : -1
                  posA.x -= pushX * dirX
                  posB.x += pushX * dirX
                } else {
                  const pushY = overlapY / 2
                  const dirY = cyB > cyA ? 1 : -1
                  posA.y -= pushY * dirY
                  posB.y += pushY * dirY
                }
              }
            }
          }
          if (!resolvedAny) break
        }

        // Commit final positions
        rootIds.forEach(id => {
          const pos = positions.get(id)!
          const sz = computedSizes.get(id) ?? { w: 400, h: 300 }
          computedPositions.set(id, { x: pos.x, y: pos.y, w: sz.w, h: sz.h })
        })
      }
      return
    }

    // Non-root: strict grid layout using the uniform-gap formula.
    // Cell size at this depth = fileNodeSize(depth).
    // Container: n*cell + (n+1)*gap in both directions.
    const d   = Math.max(0, depth)
    const fsz = fileNodeSize(d)

    const items = [
      ...childSystems.map(c => ({ id: c.id, type: 'system' as const, w: 0, h: 0, wUnits: 1, hUnits: 1 })),
      ...childFiles.map(f => ({ id: f.id, type: 'file'   as const, w: 0, h: 0, wUnits: 1, hUnits: 1 })),
    ].sort((a, b) => getSortKey(a.id) - getSortKey(b.id))

    for (const item of items) {
      if ((++work & 255) === 0) yield
      if (item.type === 'system') {
        const sz = computedSizes.get(item.id) ?? { w: containerW(1, d + 1), h: containerH(1, d + 1) }
        item.wUnits = wUnitsFor(sz.w, d)
        item.hUnits = hUnitsFor(sz.h, d)
        item.w = sz.w
        item.h = sz.h
      } else {
        item.w = fsz.w
        item.h = fsz.h
        item.wUnits = 1
        item.hUnits = 1
      }
    }

    if (!isTidy) {
      // 1. Snapped grid placement based on existing positions
      let maxColUsed = 1
      let maxRowUsed = 1
      const occupiedCells = new Set<string>()

      for (const item of items) {
        if ((++work & 255) === 0) yield
        let x = 0, y = 0
        const ext = existingMap.get(item.id)
        if (ext?.position?.x !== undefined && ext?.position?.y !== undefined) {
          x = ext.position.x
          y = ext.position.y
        } else {
          if (item.type === 'system') {
            const sys = systemsById.get(item.id)
            x = sys?.positionX ?? 0
            y = sys?.positionY ?? 0
          } else {
            const file = filesById.get(item.id)
            x = file?.positionX ?? 0
            y = file?.positionY ?? 0
          }
        }

        const gap = gridGap(d)
        const cw = fsz.w
        const ch = fsz.h
        const col = Math.max(0, Math.round((x - gap) / (cw + gap)))
        const row = Math.max(0, Math.round((y - gap) / (ch + gap)))

        // Check if this block is free
        let fits = true
        for (let c = col; c < col + item.wUnits; c++) {
          if ((++work & 255) === 0) yield
          for (let r = row; r < row + item.hUnits; r++) {
            if ((++work & 255) === 0) yield
            if (occupiedCells.has(`${c}-${r}`)) {
              fits = false
              break
            }
          }
          if (!fits) break
        }

        let foundCol = col
        let foundRow = row

        if (!fits) {
          let found = false
          // Spiral search up to radius 15
          for (let r_limit = 1; r_limit <= 15; r_limit++) {
            if ((++work & 255) === 0) yield
            for (let dx = -r_limit; dx <= r_limit; dx++) {
              if ((++work & 255) === 0) yield
              for (let dy = -r_limit; dy <= r_limit; dy++) {
                if ((++work & 255) === 0) yield
                if (Math.abs(dx) !== r_limit && Math.abs(dy) !== r_limit) continue
                const c = col + dx
                const r = row + dy
                if (c < 0 || r < 0) continue

                let possible = true
                for (let cc = c; cc < c + item.wUnits; cc++) {
                  if ((++work & 255) === 0) yield
                  for (let rr = r; rr < r + item.hUnits; rr++) {
                    if ((++work & 255) === 0) yield
                    if (occupiedCells.has(`${cc}-${rr}`)) {
                      possible = false
                      break
                    }
                  }
                  if (!possible) break
                }
                if (possible) {
                  foundCol = c
                  foundRow = r
                  found = true
                  break
                }
              }
              if (found) break
            }
            if (found) break
          }
        }

        const snapX = cellX(foundCol, d)
        const snapY = cellY(foundRow, d)

        computedPositions.set(item.id, { x: snapX, y: snapY, w: item.w, h: item.h })
        if (item.type === 'system') {
          computedSizes.set(item.id, { w: item.w, h: item.h })
        }

        // Mark cells as occupied
        for (let c = foundCol; c < foundCol + item.wUnits; c++) {
          if ((++work & 255) === 0) yield
          for (let r = foundRow; r < foundRow + item.hUnits; r++) {
            if ((++work & 255) === 0) yield
            occupiedCells.add(`${c}-${r}`)
          }
        }

        maxColUsed = Math.max(maxColUsed, foundCol + item.wUnits)
        maxRowUsed = Math.max(maxRowUsed, foundRow + item.hUnits)
      }

      const totalW = containerW(maxColUsed, d)
      const totalH = containerH(maxRowUsed, d)
      computedSizes.set(systemId, { w: totalW, h: totalH })
    } else {
      // 2. Auto packing: organic cluster with per-item breathing room.
      const packed = packFrame(
        items.map(item => ({ id: item.id, width: item.w, height: item.h })),
        { baseGap: FRAME_ITEM_GAP },
      )
      // The top inset is the tab band, not the plain gap. This used to place
      // the first row at `gap` from the frame's top border on every side
      // equally, which only cleared the tab because the old gap happened to be
      // about as tall as it; at depth it did not.
      let insets = frameContentInsets(420, Math.max(0, d))
      for (let round = 0; round < 4; round++) {
        if ((++work & 255) === 0) yield
        insets = frameContentInsets(packed.height + insets.top + insets.bottom, Math.max(0, d))
      }
      for (const item of items) {
        if ((++work & 255) === 0) yield
        const position = packed.positions.get(item.id)!
        computedPositions.set(item.id, { x: insets.left + position.x, y: insets.top + position.y, w: item.w, h: item.h })
        if (item.type === 'system') computedSizes.set(item.id, { w: item.w, h: item.h })
      }
      computedSizes.set(systemId, {
        w: packed.width + insets.left + insets.right,
        h: packed.height + insets.top + insets.bottom,
      })
    }
  }

  yield* layoutNode(null, -1)
  return computedPositions
}


export function* prepareFloorGeometrySteps(
  systems: GeometrySystem[],
  files: GeometryFile[],
  infraNodes: GeometryInfra[],
  dependencies: GeometryDependency[],
  floorLayouts: FloorLayout[],
  generatedPlacements: Map<string, GeneratedPlacement> = new Map(),
): Generator<void, PreparedFloorGeometry, void> {
  let work = 0
  const systemsById = new Map(systems.map(system => [system.id, system]))
  const filesById = new Map(files.map(file => [file.id, file]))
  const infraById = new Map(infraNodes.map(infra => [infra.id, infra]))
  const layoutsById = new Map(floorLayouts.map(layout => [layout.nodeId, layout]))
  const initialGraphLayout = floorLayouts.length === 0
    ? yield* runAlternateAxisLayoutSteps(systems, files, infraNodes, dependencies, new Map())
    : null
  const nodeTypes = new Map<string, FloorNodeType>([
    ...systems.map(system => [system.id, 'system'] as const),
    ...files.map(file => [file.id, 'file'] as const),
    ...infraNodes.map(infra => [infra.id, 'infra'] as const),
  ])

  for (const id of generatedPlacements.keys()) if (!nodeTypes.has(id)) generatedPlacements.delete(id)

  const parentById = new Map<string, string | null>()
  for (const system of systems) parentById.set(system.id, layoutsById.has(system.id) ? layoutsById.get(system.id)!.parentNodeId : system.parentId)
  for (const file of files) parentById.set(file.id, layoutsById.has(file.id) ? layoutsById.get(file.id)!.parentNodeId : file.systemId)
  for (const infra of infraNodes) parentById.set(infra.id, layoutsById.get(infra.id)?.parentNodeId ?? null)

  // Invalid/missing parents and cycles degrade to root instead of making the
  // graph disappear. The API rejects new invalid writes; this protects legacy DBs.
  for (const [id, parentId] of parentById) {
    if ((++work & 255) === 0) yield
    if (parentId && (!nodeTypes.has(parentId) || nodeTypes.get(parentId) === 'file')) parentById.set(id, null)
    const visited = new Set<string>([id])
    let current = parentById.get(id) ?? null
    while (current) {
      if ((++work & 255) === 0) yield
      if (visited.has(current)) { parentById.set(id, null); break }
      visited.add(current)
      current = parentById.get(current) ?? null
    }
  }

  const siblingsByParent = new Map<string | null, string[]>()
  for (const [id, parentId] of parentById) {
    if ((++work & 255) === 0) yield
    const siblings = siblingsByParent.get(parentId) ?? []
    siblings.push(id)
    siblingsByParent.set(parentId, siblings)
  }
  for (const siblings of siblingsByParent.values()) siblings.sort()

  const geometryById = new Map<string, ReturnType<typeof normalizeGeometry>>()
  const occupiedByParent = new Map<string | null, Array<{ x: number; y: number; width: number; height: number }>>()
  const defaultSize = (id: string) => {
    const system = systemsById.get(id)
    if (system) return { width: system.width ?? 620, height: system.height ?? 420 }
    const file = filesById.get(id)
    if (file) return { width: file.width ?? BASE_FILE_W, height: file.height ?? BASE_FILE_H }
    const infra = infraById.get(id)
    return infra?.category === 'platform' ? PLATFORM_FRAME_SIZE : INFRA_CARD_SIZE
  }

  const depthCache = new Map<string, number>()
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id)
    if (cached !== undefined) return cached
    const parentId = parentById.get(id) ?? null
    const value = parentId ? depthOf(parentId) + 1 : 0
    depthCache.set(id, value)
    return value
  }

  /**
   * Where a child may sit inside a frame. One helper so incremental placement,
   * fresh packing and drop placement cannot drift apart on the tab allowance.
   */
  const insetsOf = (containerId: string) => {
    const container = geometryById.get(containerId)
    const base = defaultSize(containerId)
    return frameContentInsets(container?.height ?? base.height, depthOf(containerId))
  }

  // A genuinely fresh Floor is packed bottom-up: deepest frames first, each
  // frame sized from its packed contents, so a parent can never be smaller
  // than what it holds and post-hoc growth never creates sibling overlap.
  const freshPackPositions = new Map<string, { x: number; y: number }>()
  const freshPackSizes = new Map<string, { width: number; height: number }>()
  if (initialGraphLayout) {
    const sizeOf = (id: string) => freshPackSizes.get(id) ?? defaultSize(id)
    const packedFrames = new Set<string>()
    const packContainer = (containerId: string) => {
      if (packedFrames.has(containerId)) return
      packedFrames.add(containerId)
      const children = siblingsByParent.get(containerId) ?? []
      for (const childId of children) if (siblingsByParent.has(childId)) packContainer(childId)
      if (children.length === 0) return
      const packed = packFrame(
        children.map(childId => ({ id: childId, ...sizeOf(childId) })),
        { baseGap: FRAME_ITEM_GAP },
      )
      // The title chrome scales with the frame's presentation scale, and the
      // frame's size depends on the header in turn - iterate to the fixed
      // point so children never start under the rendered title band.
      const base = defaultSize(containerId)
      const depth = depthOf(containerId)
      let insets = frameContentInsets(420, depth)
      for (let round = 0; round < 4; round++) {
        insets = frameContentInsets(Math.max(220, packed.height + insets.top + insets.bottom), depth)
      }
      for (const childId of children) {
        const position = packed.positions.get(childId)!
        freshPackPositions.set(childId, {
          x: insets.left + position.x,
          y: insets.top + position.y,
        })
      }
      freshPackSizes.set(containerId, {
        width: Math.max(320, packed.width + insets.left + insets.right),
        height: Math.max(220, packed.height + insets.top + insets.bottom),
      })
    }
    for (const parentKey of siblingsByParent.keys()) {
      if ((++work & 255) === 0) yield
      if (parentKey) packContainer(parentKey)
    }
  }

  const generatedLayoutNodeIds = new Set<string>()
  const placementCandidates = [...parentById].map(([id, parentId]) => {
    const layout = layoutsById.get(id)
    const fallback = defaultSize(id)
    const semantic = systemsById.get(id) ?? filesById.get(id) ?? infraById.get(id)
    const initialPosition = parentId === null ? initialGraphLayout?.get(id) : undefined
    let x = layout?.positionX ?? initialPosition?.x ?? semantic?.positionX ?? 0
    let y = layout?.positionY ?? initialPosition?.y ?? semantic?.positionY ?? 0
    const fresh = freshPackPositions.get(id)
    if (!layout && x === 0 && y === 0 && fresh) {
      x = fresh.x
      y = fresh.y
    }
    if (!layout) generatedLayoutNodeIds.add(id)
    return {
      id,
      parentId,
      layout,
      fallback,
      x,
      y,
      placementPriority: layout ? 0 as const : (fresh || x !== 0 || y !== 0) ? 1 as const : 2 as const,
    }
  })

  // Database/API order is not spatial order. Register every persisted sibling
  // first so an incoming system/file cannot be placed underneath a persisted
  // node that happens to appear later in the snapshot.
  // Infrastructure nobody has placed goes in a band below the map rather than
  // wherever the packer finds a gap; it is placed after everything else so
  // the band knows where the map ends.
  const bandedInfra: typeof placementCandidates = []
  for (const candidate of orderFramePlacementCandidates(placementCandidates)) {
    if ((++work & 255) === 0) yield
    const { id, parentId, layout, fallback } = candidate
    if (!layout && parentId === null && infraById.has(id)) {
      const remembered = generatedPlacements.get(id)
      if (!remembered || remembered.parentId !== null) {
        bandedInfra.push(candidate)
        continue
      }
    }
    let { x, y } = candidate
    const occupied = occupiedByParent.get(parentId) ?? []
    if (candidate.placementPriority === 2) {
      // Decide this ONCE. Re-deriving it on every projection made a node's
      // position depend on the current geometry of everything around it, so a
      // single drop scattered every unpersisted node in the frame.
      const remembered = generatedPlacements.get(id)
      if (remembered && remembered.parentId === parentId) {
        x = remembered.x
        y = remembered.y
      } else {
        // A node indexed after the initial layout was persisted clusters in
        // beside its siblings instead of landing on a blind grid.
        const spot = placeIncoming(
          { id, width: fallback.width, height: fallback.height },
          occupied,
          {
            // Same clearance a drop or a repack would use, so a node that
            // arrives by indexing sits exactly as tightly as one placed by hand.
            baseGap: parentId ? FRAME_ITEM_GAP : FRAME_ROOT_GAP,
            origin: parentId
              ? { x: insetsOf(parentId).left, y: insetsOf(parentId).top }
              : { x: 80, y: 80 },
          },
        )
        x = spot.x
        y = spot.y
        generatedPlacements.set(id, { parentId, x, y })
      }
    } else if (generatedPlacements.has(id)) {
      // It has real geometry now - persisted, semantic, or freshly packed - so
      // the remembered guess must not outlive it.
      generatedPlacements.delete(id)
    }
    const freshSize = freshPackSizes.get(id)
    const geometry = normalizeGeometry({
      x, y,
      width: layout?.width ?? freshSize?.width ?? fallback.width,
      height: layout?.height ?? freshSize?.height ?? fallback.height,
      scale: layout?.scale ?? 1,
      interiorScale: layout?.interiorScale ?? 1,
    }, fallback)
    geometryById.set(id, geometry)
    occupied.push({ x: geometry.x, y: geometry.y, width: geometry.width * geometry.scale, height: geometry.height * geometry.scale })
    occupiedByParent.set(parentId, occupied)
  }

  if (bandedInfra.length > 0) {
    const roots = occupiedByParent.get(null) ?? []
    const band = placeInfraBand(
      bandedInfra.map(candidate => ({
        id: candidate.id,
        category: infraById.get(candidate.id)?.category ?? 'api',
        ...candidate.fallback,
      })),
      roots,
      FRAME_ROOT_GAP,
    )
    for (const candidate of bandedInfra) {
      if ((++work & 255) === 0) yield
      const spot = band.get(candidate.id)!
      generatedPlacements.set(candidate.id, { parentId: null, x: spot.x, y: spot.y })
      const geometry = normalizeGeometry({
        x: spot.x, y: spot.y,
        width: candidate.fallback.width, height: candidate.fallback.height,
        scale: 1, interiorScale: 1,
      }, candidate.fallback)
      geometryById.set(candidate.id, geometry)
      roots.push({ x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height })
    }
    occupiedByParent.set(null, roots)
  }

  const resizedContainerIds = new Set<string>()
  // Initial-index/legacy containers auto-fit their direct children. Persisted
  // containers retain authored dimensions as a minimum, but may grow when a
  // newly indexed child would otherwise sit outside their frame.
  for (const [containerId, children] of siblingsByParent) {
    if ((++work & 255) === 0) yield
    if (!containerId) continue
    const isContainer = systemsById.has(containerId) || infraById.get(containerId)?.category === 'platform'
    if (!isContainer || children.length === 0) continue
    const hasIncomingChild = children.some(childId => !layoutsById.has(childId))
    if (layoutsById.has(containerId) && !hasIncomingChild) continue
    const container = geometryById.get(containerId)
    if (!container) continue
    const childFrames = children.flatMap(childId => {
      const child = geometryById.get(childId)
      return child ? [child] : []
    })
    // A persisted frame hemmed in by neighbours compresses its interior
    // rather than growing over them - an agent assigning a batch of files to
    // a system used to push that system on top of the next one.
    const containerParent = parentById.get(containerId) ?? null
    const siblingRects = layoutsById.has(containerId)
      ? (siblingsByParent.get(containerParent) ?? []).flatMap(siblingId => {
          if (siblingId === containerId) return []
          const sibling = geometryById.get(siblingId)
          return sibling
            ? [{ x: sibling.x, y: sibling.y, width: sibling.width * sibling.scale, height: sibling.height * sibling.scale }]
            : []
        })
      : []
    const fitted = fitFrameAmongSiblings(
      container, childFrames, insetsOf(containerId).right, siblingRects,
      containerParent ? FRAME_ITEM_GAP : FRAME_ROOT_GAP,
    )
    geometryById.set(containerId, fitted)
    if (fitted.width !== container.width || fitted.height !== container.height ||
        fitted.interiorScale !== container.interiorScale) {
      resizedContainerIds.add(containerId)
    }
  }

  // The relationship-aware initializer was historically sized for the legacy
  // grid renderer. Resolve its root collisions again using the materialized
  // freeform frame bounds while retaining the force-directed neighborhood.
  if (initialGraphLayout) {
    const rootIds = siblingsByParent.get(null) ?? []
    const padding = 72
    for (let pass = 0; pass < 100; pass++) {
      if ((++work & 255) === 0) yield
      let moved = false
      for (let leftIndex = 0; leftIndex < rootIds.length; leftIndex++) {
        if ((++work & 255) === 0) yield
        const left = geometryById.get(rootIds[leftIndex])!
        const leftWidth = left.width * left.scale
        const leftHeight = left.height * left.scale
        for (let rightIndex = leftIndex + 1; rightIndex < rootIds.length; rightIndex++) {
          if ((++work & 255) === 0) yield
          const right = geometryById.get(rootIds[rightIndex])!
          const rightWidth = right.width * right.scale
          const rightHeight = right.height * right.scale
          const overlapX = Math.min(left.x + leftWidth + padding, right.x + rightWidth + padding) - Math.max(left.x, right.x)
          const overlapY = Math.min(left.y + leftHeight + padding, right.y + rightHeight + padding) - Math.max(left.y, right.y)
          if (overlapX <= 0 || overlapY <= 0) continue
          moved = true
          if (overlapX < overlapY) {
            const direction = right.x + rightWidth / 2 >= left.x + leftWidth / 2 ? 1 : -1
            left.x -= direction * overlapX / 2
            right.x += direction * overlapX / 2
          } else {
            const direction = right.y + rightHeight / 2 >= left.y + leftHeight / 2 ? 1 : -1
            left.y -= direction * overlapY / 2
            right.y += direction * overlapY / 2
          }
        }
      }
      if (!moved) break
    }
  }

  const depthById = new Map<string, number>()
  const worldScaleById = new Map<string, number>()
  const contentScaleById = new Map<string, number>()
  // A frame's own world scale and the scale it hands to its children are two
  // different numbers. They differ exactly when a container compresses its
  // interior, which is what lets that compression leave the container's own
  // size - and everything derived from it - completely untouched.
  const resolveFrame = (id: string): { depth: number; worldScale: number; contentScale: number } => {
    const cachedDepth = depthById.get(id)
    const cachedScale = worldScaleById.get(id)
    const cachedContent = contentScaleById.get(id)
    if (cachedDepth !== undefined && cachedScale !== undefined && cachedContent !== undefined) {
      return { depth: cachedDepth, worldScale: cachedScale, contentScale: cachedContent }
    }
    const parentId = parentById.get(id) ?? null
    const parent = parentId ? resolveFrame(parentId) : { depth: -1, worldScale: 1, contentScale: 1 }
    const geometry = geometryById.get(id)
    const worldScale = parent.contentScale * (geometry?.scale ?? 1)
    const result = {
      depth: parent.depth + 1,
      worldScale,
      contentScale: worldScale * (geometry?.interiorScale ?? 1),
    }
    depthById.set(id, result.depth)
    worldScaleById.set(id, result.worldScale)
    contentScaleById.set(id, result.contentScale)
    return result
  }

  const descriptors: FloorSceneDescriptor[] = [...parentById.keys()].map(id => {
    const resolved = resolveFrame(id)
    return { id, nodeType: nodeTypes.get(id)!, parentId: parentById.get(id) ?? null, geometry: geometryById.get(id)!, ...resolved }
  }).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  return { descriptors, siblingsByParent, geometryById, worldScaleById, contentScaleById,
    generatedLayoutNodeIds, resizedContainerIds, generatedPlacements }
}

export const prepareFloorGeometry = (...args: Parameters<typeof prepareFloorGeometrySteps>) => completeGeometry(prepareFloorGeometrySteps(...args))
