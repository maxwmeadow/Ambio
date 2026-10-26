import type { InternalNode, Node, Rect } from '@xyflow/react'
import { sceneRecordSteps, type SceneRecord } from '../renderBudgetGeometry.ts'

/** Complete geometry is independent of Flow's disposable interaction subset. */
export interface CanonicalScene {
  nodes: Node[]
  byId: Pick<ReadonlyMap<string, Node>, 'get' | 'has' | 'size'>
  order: Map<string, number>
  rects: Map<string, Rect>
  records: SceneRecord[]
}

// Keep the lookup in its own object scope. Closures created inside
// canonicalScene share a V8 context with geometry-comparison callbacks, which
// capture `previous` and can retain every earlier scene through that context.
class CanonicalNodeLookup {
  private nodes: Node[]
  private order: ReadonlyMap<string, number>
  constructor(nodes: Node[], order: ReadonlyMap<string, number>) { this.nodes = nodes; this.order = order }
  get size() { return this.nodes.length }
  has(id: string) { return this.order.has(id) }
  get(id: string) { const i = this.order.get(id); return i === undefined ? undefined : this.nodes[i] }
}

export function canonicalScene(nodes: Node[], records: SceneRecord[], previous?: CanonicalScene): CanonicalScene {
  const steps = canonicalSceneSteps(nodes, records, previous)
  for (;;) { const result = steps.next(); if (result.done) return result.value }
}

export function* canonicalSceneSteps(nodes: Node[], records: SceneRecord[], previous?: CanonicalScene): Generator<void, CanonicalScene> {
  if (previous?.nodes === nodes && previous.records === records) return previous
  let work = 0
  let sameOrder = Boolean(previous && nodes.length === previous.nodes.length)
  if (sameOrder && !(records === previous!.records && records.length === nodes.length)) {
    for (let i = 0; i < nodes.length; i++) {
      if (++work % 256 === 0) yield
      if (nodes[i].id !== previous!.nodes[i].id) { sameOrder = false; break }
    }
  }
  let order = sameOrder ? previous!.order : undefined
  if (!order) {
    order = new Map()
    for (let i = 0; i < nodes.length; i++) { if (++work % 256 === 0) yield; order.set(nodes[i].id, i) }
  }
  // Selection changes two entries in an immutable node array. A keyed view
  // avoids cloning a 100k-entry Map merely to point at those new objects.
  const byId = new CanonicalNodeLookup(nodes, order)
  let sameGeometry = Boolean(previous && records.length === previous.records.length)
  if (sameGeometry && records !== previous!.records) {
    for (let i = 0; i < records.length; i++) {
      if (++work % 256 === 0) yield
      const record = records[i], before = previous!.records[i]
      if (record !== before && !(record.id === before.id && record.parentId === before.parentId &&
        record.x === before.x && record.y === before.y && record.width === before.width && record.height === before.height)) {
        sameGeometry = false; break
      }
    }
  }
  let rects = sameGeometry ? previous!.rects : undefined
  if (!rects) {
    rects = new Map()
    const raw = new Map<string, SceneRecord>()
    for (const record of records) { if (++work % 256 === 0) yield; raw.set(record.id, record) }
    for (const record of records) {
      if (++work % 256 === 0) yield
      if (rects.has(record.id)) continue
      const parent = record.parentId ? rects.get(record.parentId) : undefined
      if (!record.parentId || parent) {
        rects.set(record.id, { x: record.x + (parent?.x ?? 0), y: record.y + (parent?.y ?? 0), width: record.width, height: record.height })
        continue
      }
      const chain: SceneRecord[] = [], seen = new Set<string>()
      let current: SceneRecord | undefined = record
      while (current && !rects.has(current.id) && !seen.has(current.id)) {
        if (++work % 256 === 0) yield
        seen.add(current.id); chain.push(current)
        current = current.parentId ? raw.get(current.parentId) : undefined
      }
      for (let i = chain.length - 1; i >= 0; i--) {
        if (++work % 256 === 0) yield
        const child = chain[i], parent = child.parentId ? rects.get(child.parentId) : undefined
        rects.set(child.id, { x: child.x + (parent?.x ?? 0), y: child.y + (parent?.y ?? 0), width: child.width, height: child.height })
      }
    }
  }
  return { nodes, byId, order, rects, records }
}

// Only completed immutable projections are cached. Weak keys allow obsolete
// projections (including cancelled preparation) to be collected with the scene.
const preparedScenes = new WeakMap<Node[], CanonicalScene>()
export const preparedCanonicalScene = (nodes: Node[]) => preparedScenes.get(nodes)
/** Only for selection/overlay changes that preserve IDs, order, geometry,
 * hidden state and semantic-detail flags. Never use for structural edits. */
export function rememberPresentationScene(source: Node[], nodes: Node[]): Node[] {
  const scene = preparedScenes.get(source)
  if (scene && source !== nodes) preparedScenes.set(nodes, { ...scene, nodes, byId: new CanonicalNodeLookup(nodes, scene.order) })
  return nodes
}
export function* prepareCanonicalSceneSteps(nodes: Node[], previous?: CanonicalScene): Generator<void, CanonicalScene> {
  const records = yield* sceneRecordSteps(nodes, previous?.records)
  const scene = yield* canonicalSceneSteps(nodes, records, previous)
  preparedScenes.set(nodes, scene)
  return scene
}

/** Iterate the admitted set, never the complete project, on camera answers. */
export function materializedIds(scene: CanonicalScene, visible: Iterable<string>, priority: Iterable<string>, retained: Iterable<string> = []): string[] {
  const ids = new Set<string>()
  for (const group of [visible, priority, retained]) for (const id of group) {
    let node = scene.byId.get(id)
    while (node && !ids.has(node.id)) {
      ids.add(node.id)
      node = node.parentId ? scene.byId.get(node.parentId) : undefined
    }
  }
  const ordered: string[] = [], visited = new Set<string>()
  for (const id of [...ids].sort((a, b) => scene.order.get(a)! - scene.order.get(b)!)) {
    const chain: string[] = []
    let current: string | undefined = id
    while (current && ids.has(current) && !visited.has(current)) {
      visited.add(current); chain.push(current); current = scene.byId.get(current)?.parentId
    }
    for (let i = chain.length - 1; i >= 0; i--) ordered.push(chain[i])
  }
  return ordered
}

/** Geometry fallback for controllers; never inserted into Flow's store. */
export function canonicalInternalNode(scene: CanonicalScene | undefined, id: string): InternalNode | undefined {
  const node = scene?.byId.get(id), rect = scene?.rects.get(id)
  if (!node || !rect) return
  return { ...node, measured: { width: rect.width, height: rect.height },
    internals: { positionAbsolute: { x: rect.x, y: rect.y }, z: node.zIndex ?? 0, userNode: node } } as InternalNode
}

/** Offscreen children still participate in resize compensation. */
export function canonicalChildStarts(scene: CanonicalScene, parentId: string): Map<string, { x: number; y: number }> {
  const children = new Map<string, { x: number; y: number }>()
  for (const node of scene.nodes) if (node.parentId === parentId) children.set(node.id, { ...node.position })
  return children
}

export function canonicalBounds(scene: CanonicalScene, ids?: Iterable<string>): Rect | undefined {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  const candidates = ids ?? scene.nodes.filter(node => !node.hidden).map(node => node.id)
  for (const id of candidates) {
    const rect = scene.rects.get(id)
    if (!rect || !(rect.width > 0 && rect.height > 0)) continue
    left = Math.min(left, rect.x); top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height)
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : undefined
}

const scenes = new WeakMap<object, CanonicalScene>()
// useStoreApi returns a distinct facade per hook; getState identifies the
// underlying provider and keeps nested/bin canvases independent.
const sceneKey = (store: object) => 'getState' in store ? store.getState as object : store
export const canvasScene = (store: object) => scenes.get(sceneKey(store))
export function registerCanvasScene(store: object, scene: CanonicalScene) { scenes.set(sceneKey(store), scene) }
export function releaseCanvasScene(store: object, scene: CanonicalScene) {
  const key = sceneKey(store)
  if (scenes.get(key) === scene) scenes.delete(key)
}
