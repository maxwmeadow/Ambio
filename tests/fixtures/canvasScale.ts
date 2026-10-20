import type { CanvasSnapshot, DbFile, DbSystem, FloorLayout } from '../../src/shared/types'
import { resolve } from 'node:path'
export interface ScaleOptions {
  entities: number; visibleSystems?: number; depth?: number; roots?: number
  edges?: 'none' | 'chain' | 'hub'; saved?: boolean
}
/** Seeded by indices, with a fixed local neighborhood and distant background.
 * Counts describe entities, not file capacity or simultaneously readable cards. */
export function canvasScaleFixture(options: ScaleOptions): CanvasSnapshot {
  const { entities, visibleSystems = 8, depth = 1, roots = 1, edges = 'none', saved = true } = options
  if (!Number.isSafeInteger(entities) || entities < 7 || entities > 1_000_000) throw Error('entities must be 7..1000000')
  if (![visibleSystems, depth, roots].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('fixture dimensions must be positive integers')
  const systemCount = Math.ceil(entities / 7), fileCount = entities - systemCount
  const systems: DbSystem[] = [], files: DbFile[] = [], floorLayouts: FloorLayout[] = []
  for (let i = 0; i < systemCount; i++) {
    const nested = depth > 1 && i % depth !== 0
    const parentId = nested ? `scale-system-${i - 1}` : null
    const local = i < visibleSystems
    const x = nested ? 40 : local ? (i % 4) * 1000 : 1_000_000 + (i % 100) * 1000
    const y = nested ? 60 : local ? Math.floor(i / 4) * 900 : Math.floor(i / 100) * 900
    systems.push({ id: `scale-system-${i}`, workspaceId: 'demo', name: `Scale System ${i}`, parentId,
      source: 'user', color: null, description: null, agentNotes: null, depth: i % depth,
      positionX: x, positionY: y, width: 620, height: 420, createdAt: 1, updatedAt: 1 })
    floorLayouts.push({ workspaceId: 'demo', nodeId: `scale-system-${i}`, nodeType: 'system',
      parentNodeId: parentId, parentNodeType: parentId ? 'system' : null, containmentKind: parentId ? 'part_of' : 'root', positionX: x, positionY: y,
      width: 620, height: 420, scale: 1, interiorScale: 1, updatedAt: 1 })
  }
  for (let i = 0; i < fileCount; i++) {
    const systemId = systems[Math.floor(i / 6)].id, slot = i % 6
    files.push({ id: `scale-file-${i}`, rootId: `scale-root-${i % roots}`,
      path: resolve('fixture', `root-${i % roots}`, `module-${i}.ts`), relPath: `root-${i % roots}/module-${i}.ts`,
      language: 'typescript', systemId, lineCount: 100, churnScore: 0, indexedAt: 1, positionX: 0, positionY: 0 })
    floorLayouts.push({ workspaceId: 'demo', nodeId: `scale-file-${i}`, nodeType: 'file', parentNodeId: systemId,
      parentNodeType: 'system', containmentKind: 'part_of', positionX: 30 + (slot % 3) * 180, positionY: 80 + Math.floor(slot / 3) * 140,
      width: 160, height: 100, scale: 1, interiorScale: 1, updatedAt: 1 })
  }
  const dependencies = edges === 'none' ? [] : systems.slice(1).map((system, i) => ({
    id: `scale-edge-${i}`, workspaceId: 'demo', src: edges === 'hub' ? systems[0].id : systems[i].id,
    dst: system.id, srcType: 'system' as const, dstType: 'system' as const,
    dependencyType: 'DEPENDS_ON', weight: 1, createdBy: 'user' as const,
  }))
  return { workspaceId: 'demo', systems, files, dependencies, infraNodes: [], floorLayouts: saved ? floorLayouts : [] }
}

/** Preserve the earlier dense audit workload while sharing fixture generation. */
export function canvasDenseFixture(template: { system: DbSystem; file: DbFile }, count: number): CanvasSnapshot {
  const columns = Math.ceil(Math.sqrt(count * 1.4))
  const systems = Array.from({ length: count }, (_, i) => ({
    ...template.system, id: `perf-system-${i}`, parentId: null, depth: 0,
    name: `Subsystem ${i}`, source: 'user' as const, positionX: (i % columns) * 660,
    positionY: Math.floor(i / columns) * 460, width: 620, height: 420,
  }))
  const files = systems.flatMap(system => Array.from({ length: 6 }, (_, j) => ({
    ...template.file, id: `perf-file-${system.id.slice('perf-system-'.length)}-${j}`, systemId: system.id,
    relPath: `${system.id.replace('perf-system-','subsystem-')}/module-${j}.ts`,
    path: resolve('fixture', system.id.replace('perf-system-','subsystem-'), `module-${j}.ts`),
  })))
  return { workspaceId: 'demo', systems, files, infraNodes: [], dependencies: [], floorLayouts: [] }
}
