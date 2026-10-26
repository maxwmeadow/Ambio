import type { FloorGeometryInput } from './sceneGeometry'

const systemFields = ['id', 'parentId', 'positionX', 'positionY', 'width', 'height'] as const
const fileFields = ['id', 'systemId', 'positionX', 'positionY', 'width', 'height'] as const
const infraFields = ['id', 'category', 'positionX', 'positionY'] as const
const layoutFields = ['nodeId', 'parentNodeId', 'positionX', 'positionY', 'width', 'height', 'scale', 'interiorScale'] as const
export function sameGeometryInput(a: FloorGeometryInput, b: FloorGeometryInput): boolean {
  const steps = sameGeometryInputSteps(a, b)
  for (;;) { const result = steps.next(); if (result.done) return result.value }
}
export function* sameGeometryInputSteps(a: FloorGeometryInput, b: FloorGeometryInput): Generator<void, boolean> {
  let work = 0
  for (const [before, after, fields] of [
    [a.systems, b.systems, systemFields], [a.files, b.files, fileFields],
    [a.infraNodes, b.infraNodes, infraFields], [a.dependencies, b.dependencies, ['src', 'dst']],
  ] as Array<[any[], any[], readonly string[]]>) {
    if (before.length !== after.length) return false
    for (let i = 0; i < before.length; i++) {
      if (!fields.every(field => Object.is(before[i][field], after[i][field]))) return false
      if ((++work & 255) === 0) yield
    }
  }
  if (a.layouts.length !== b.layouts.length || a.placements.size !== b.placements.size) return false
  const layouts = new Map<string, FloorGeometryInput['layouts'][number]>()
  for (const row of a.layouts) { layouts.set(row.nodeId, row); if ((++work & 255) === 0) yield }
  for (const row of b.layouts) {
    const before = layouts.get(row.nodeId)
    if (!before || !layoutFields.every(field => Object.is(before[field], row[field]))) return false
    if ((++work & 255) === 0) yield
  }
  for (const [id, placement] of a.placements) {
    const other = b.placements.get(id)
    if (!other || placement.parentId !== other.parentId || placement.x !== other.x || placement.y !== other.y) return false
    if ((++work & 255) === 0) yield
  }
  return true
}
