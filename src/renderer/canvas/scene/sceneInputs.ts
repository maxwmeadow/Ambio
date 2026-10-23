import type { FloorGeometryInput } from './sceneGeometry'

const systemFields = ['id', 'parentId', 'positionX', 'positionY', 'width', 'height'] as const
const fileFields = ['id', 'systemId', 'positionX', 'positionY', 'width', 'height'] as const
const infraFields = ['id', 'category', 'positionX', 'positionY'] as const
const layoutFields = ['nodeId', 'parentNodeId', 'positionX', 'positionY', 'width', 'height', 'scale', 'interiorScale'] as const
function sameRows<T>(a: T[], b: T[], fields: readonly (keyof T)[]) {
  return a.length === b.length && a.every((row, i) => fields.every(field => Object.is(row[field], b[i][field])))
}
export function sameGeometryInput(a: FloorGeometryInput, b: FloorGeometryInput): boolean {
  if (!sameRows(a.systems, b.systems, systemFields) || !sameRows(a.files, b.files, fileFields) ||
    !sameRows(a.infraNodes, b.infraNodes, infraFields) || !sameRows(a.dependencies, b.dependencies, ['src', 'dst']) ||
    a.layouts.length !== b.layouts.length || a.placements.size !== b.placements.size) return false
  const layouts = new Map(a.layouts.map(row => [row.nodeId, row]))
  for (const row of b.layouts) {
    const before = layouts.get(row.nodeId)
    if (!before || !layoutFields.every(field => Object.is(before[field], row[field]))) return false
  }
  for (const [id, placement] of a.placements) {
    const other = b.placements.get(id)
    if (!other || placement.parentId !== other.parentId || placement.x !== other.x || placement.y !== other.y) return false
  }
  return true
}
