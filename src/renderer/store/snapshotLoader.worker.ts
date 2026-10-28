import type { CanvasSnapshot } from '../../shared/types'

let batches: Generator<unknown> | undefined
function* snapshotBatches(snapshot: CanvasSnapshot) {
  for (const field of ['systems', 'files', 'infraNodes', 'dependencies', 'floorLayouts'] as const) {
    const rows = snapshot[field] ?? []
    for (let start = 0; start < rows.length; start += 512) yield { field, rows: rows.slice(start, start + 512) }
  }
  yield { done: true, workspaceId: snapshot.workspaceId }
}
self.onmessage = event => {
  try {
    if (event.data instanceof ArrayBuffer) batches = snapshotBatches(JSON.parse(new TextDecoder().decode(event.data)))
    const result = batches?.next()
    if (result && !result.done) self.postMessage(result.value)
  } catch (error) {
    batches = undefined
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
