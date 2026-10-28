/** Bound each structured-clone operation, including maps in prepared geometry. */
export interface SceneChunk { field: string; kind: 'array' | 'map' | 'set'; rows: any[] }
export function* sceneChunks(value: object): Generator<SceneChunk> {
  for (const [field, collection] of Object.entries(value)) {
    const kind = collection instanceof Map ? 'map' : collection instanceof Set ? 'set' : 'array'
    let rows: any[] = []
    for (const row of collection) {
      rows.push(row)
      if (rows.length === 512) { yield { field, kind, rows }; rows = [] }
    }
    if (rows.length) yield { field, kind, rows }
  }
}
export function appendSceneChunk(target: object, chunk: SceneChunk) {
  const collection = (target as Record<string, any>)[chunk.field]
  if (chunk.kind === 'map' && collection instanceof Map) for (const [key, value] of chunk.rows) collection.set(key, value)
  else if (chunk.kind === 'set' && collection instanceof Set) for (const value of chunk.rows) collection.add(value)
  else if (chunk.kind === 'array' && Array.isArray(collection)) collection.push(...chunk.rows)
  else throw Error('Invalid canvas transfer batch')
}
