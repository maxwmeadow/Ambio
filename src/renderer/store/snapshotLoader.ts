import type { CanvasSnapshot } from '../../shared/types'
import { beginPerfStage, traceSync } from '../canvas/perfTrace.ts'

// Small replies need no worker. Large JSON is parsed off the UI thread, then
// delivered one acknowledged batch at a time; never clone the complete graph.
const INLINE_BYTES = 256 * 1024
export async function decodeCanvasSnapshot(response: Response, signal?: AbortSignal): Promise<CanvasSnapshot> {
  const finish = beginPerfStage('snapshot.decode')
  try {
    const bytes = await response.arrayBuffer()
    if (signal?.aborted) throw new DOMException('Snapshot cancelled', 'AbortError')
    if (bytes.byteLength <= INLINE_BYTES) return JSON.parse(new TextDecoder().decode(bytes)) as CanvasSnapshot
    return await new Promise<CanvasSnapshot>((resolve, reject) => {
      let worker: Worker | undefined, timer: ReturnType<typeof setTimeout>
      const snapshot: CanvasSnapshot = { workspaceId: '', systems: [], files: [], infraNodes: [], dependencies: [], floorLayouts: [] }
      const fields = ['systems', 'files', 'infraNodes', 'dependencies', 'floorLayouts'] as const
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker?.terminate() }
      const fail = (error: unknown) => { cleanup(); reject(error) }
      const abort = () => fail(new DOMException('Snapshot cancelled', 'AbortError'))
      const watch = () => { clearTimeout(timer); timer = setTimeout(() => fail(Error('Background map loading stopped')), 30000) }
      try {
        worker = new Worker(new URL('./snapshotLoader.worker.ts', import.meta.url), { type: 'module' })
        signal?.addEventListener('abort', abort, { once: true })
        worker.onerror = () => fail(Error('Background map loading failed'))
        worker.onmessageerror = () => fail(Error('Background map transfer failed'))
        worker.onmessage = event => {
          const data = event.data
          watch()
          if (data.error) { fail(Error(data.error)); return }
          if (data.done) { snapshot.workspaceId = data.workspaceId; cleanup(); resolve(snapshot); return }
          if (!fields.includes(data.field) || !Array.isArray(data.rows) || data.rows.length > 512) {
            fail(Error('Invalid background map batch')); return
          }
          traceSync('snapshot.batch', () => (snapshot[data.field as typeof fields[number]] as unknown[]).push(...data.rows), data.rows.length)
          worker!.postMessage({ op: 'next' })
        }
        watch()
        worker.postMessage(bytes, [bytes])
      } catch (error) { fail(error) }
    })
  } finally { finish() }
}
