export type RenderTier = 0 | 1 | 2
export interface SceneRecord {
  id: string; parentId?: string; x: number; y: number; width: number; height: number
  hidden: boolean; detail: boolean; kind: string
}
export interface ViewRect { x: number; y: number; width: number; height: number }
export interface CameraQuery { x: number; y: number; zoom: number; width: number; height: number; moving: boolean }
export interface IndexedRecord extends SceneRecord { rect: ViewRect }
export interface SceneIndex { byId: Map<string, IndexedRecord>; cells: Map<string, string[]>; large: string[] }
const CELL = 512
export const VIEW_BUFFER_PX = 240
/** Avoid mounting every root while the first worker answer is in flight. */
export function initialRootVisible(record: SceneRecord, q: CameraQuery): boolean {
  return !record.hidden && !record.parentId && intersects({ x: record.x, y: record.y, width: record.width, height: record.height }, cameraRect(q, VIEW_BUFFER_PX))
}
export function intersects(a: ViewRect, b: ViewRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
}
export function contains(a: ViewRect, b: ViewRect): boolean {
  return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height
}
export function cameraRect(q: CameraQuery, padding = 0): ViewRect {
  const z = Math.max(.0001, q.zoom)
  return { x: (-q.x - padding) / z, y: (-q.y - padding) / z, width: (q.width + 2 * padding) / z, height: (q.height + 2 * padding) / z }
}
export function buildSceneIndex(records: SceneRecord[]): SceneIndex {
  const raw = new Map(records.map(r => [r.id, r]))
  const byId = new Map<string, IndexedRecord>(), cells = new Map<string, string[]>(), large: string[] = []
  // Resolve ancestors iteratively, including malformed cycles and absent parents.
  for (const record of records) {
    const chain: SceneRecord[] = [], seen = new Set<string>()
    let current: SceneRecord | undefined = record
    while (current && !byId.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id); chain.push(current); current = current.parentId ? raw.get(current.parentId) : undefined
    }
    for (const r of chain.reverse()) {
      const parent = r.parentId ? byId.get(r.parentId)?.rect : undefined
      byId.set(r.id, { ...r, rect: { x: r.x + (parent?.x ?? 0), y: r.y + (parent?.y ?? 0), width: r.width, height: r.height } })
    }
  }
  for (const r of byId.values()) {
    if (r.hidden) continue
    const x0 = Math.floor(r.rect.x / CELL), y0 = Math.floor(r.rect.y / CELL)
    const x1 = Math.floor((r.rect.x + r.width) / CELL), y1 = Math.floor((r.rect.y + r.height) / CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { large.push(r.id); continue }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = x + ',' + y, bucket = cells.get(key)
      if (bucket) bucket.push(r.id); else cells.set(key, [r.id])
    }
  }
  return { byId, cells, large }
}
export function queryScene(index: SceneIndex, q: CameraQuery) {
  const bounds = cameraRect(q, VIEW_BUFFER_PX), viewport = cameraRect(q)
  const candidates = new Set(index.large)
  const x0 = Math.floor(bounds.x / CELL), y0 = Math.floor(bounds.y / CELL)
  const x1 = Math.floor((bounds.x + bounds.width) / CELL), y1 = Math.floor((bounds.y + bounds.height) / CELL)
  // Extreme overviews must not iterate millions of empty world-space cells.
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > index.cells.size * 2) {
    for (const bucket of index.cells.values()) for (const id of bucket) candidates.add(id)
  } else {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
      for (const id of index.cells.get(x + ',' + y) ?? []) candidates.add(id)
  }
  const visible: Array<{ id: string; tier: RenderTier; distance: number }> = []
  const cx = viewport.x + viewport.width / 2, cy = viewport.y + viewport.height / 2
  for (const id of candidates) {
    const r = index.byId.get(id)!
    if (!intersects(r.rect, bounds)) continue
    const pixels = Math.min(r.width, r.height) * q.zoom
    const onScreen = intersects(r.rect, viewport)
    const tier: RenderTier = pixels < 14 ? 0 : r.detail && onScreen && !q.moving ? 2 : 1
    visible.push({ id, tier, distance: Math.hypot(r.rect.x + r.width / 2 - cx, r.rect.y + r.height / 2 - cy) })
  }
  visible.sort((a, b) => a.distance - b.distance)
  return { visible, bounds, zoom: q.zoom }
}
