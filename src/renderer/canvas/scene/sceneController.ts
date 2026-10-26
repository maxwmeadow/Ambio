import { sceneChunks, appendSceneChunk, type SceneChunk } from './sceneTransfer.ts'
import { prepareFloorGeometrySteps, type FloorGeometryInput, type PreparedFloorGeometry } from './sceneGeometry.ts'
import { perfTrace, traceSync } from '../perfTrace.ts'

interface WorkerPort {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}
export type SceneController = ReturnType<typeof createSceneController>
const cancelled = () => new DOMException('Superseded scene preparation', 'AbortError')

/** One worker per canvas owns numeric preparation and the visibility index.
 * Tokens are never reused across restarts. Only a current job can publish. */
export function createSceneController(factory: () => WorkerPort = () => {
  if ((globalThis as { __ambioDisableRenderWorker?: boolean }).__ambioDisableRenderWorker) throw Error('Worker disabled')
  return new Worker(new URL('../renderBudget.worker.ts', import.meta.url), { type: 'module' })
}, options: { cancelTimeoutMs?: number } = {}) {
  let worker: WorkerPort | undefined, attempted = false, next = 0
  const listeners = new Set<(data: any) => void>(), errors = new Set<() => void>()
  const jobs = new Map<string, { token: number; reject: (error: Error) => void; resolve: (value: PreparedFloorGeometry) => void; input?: Generator<SceneChunk>; geometry?: PreparedFloorGeometry }>()
  let sceneUpload: { token: number; chunks: Generator<SceneChunk> } | undefined
  let sceneRecords: unknown[] = []
  const cancellations = new Map<number, ReturnType<typeof setTimeout>>()
  const clearCancellation = (token: number) => { clearTimeout(cancellations.get(token)); cancellations.delete(token) }
  const clearCancellations = () => { for (const token of cancellations.keys()) clearCancellation(token) }
  const rejectJobs = (error: Error) => { for (const job of jobs.values()) job.reject(error); jobs.clear() }
  const start = () => {
    if (attempted) return worker
    attempted = true
    try {
      worker = factory()
      worker.onmessage = event => {
        const data = event.data
        if (data.op === 'scene-input-next') {
          if (!sceneUpload || sceneUpload.token !== data.token) return
          const next = sceneUpload.chunks.next()
          traceSync('worker.scene-post', () => worker!.postMessage(next.done
            ? { op: 'scene-commit', token: data.token }
            : { op: 'scene-chunk', token: data.token, chunk: next.value }), next.done ? 0 : next.value.rows.length)
          if (next.done) sceneUpload = undefined
          return
        }
        if (data.op === 'prepare-input-next' || data.op === 'prepared-start' || data.op === 'prepared-chunk') {
          const job = jobs.get(data.channel)
          if (!job || job.token !== data.token) return
          try {
            if (data.op === 'prepare-input-next') {
              const next = job.input!.next()
              traceSync('worker.geometry-post', () => worker!.postMessage(next.done
                ? { op: 'prepare-commit', channel: data.channel, token: data.token }
                : { op: 'prepare-chunk', channel: data.channel, token: data.token, chunk: next.value }), next.done ? 0 : next.value.rows.length)
              if (next.done) job.input = undefined
            } else {
              if (data.op === 'prepared-start') job.geometry = { descriptors: [], siblingsByParent: new Map(), geometryById: new Map(), worldScaleById: new Map(), contentScaleById: new Map(), generatedLayoutNodeIds: new Set(), resizedContainerIds: new Set(), generatedPlacements: new Map() }
              else appendSceneChunk(job.geometry!, data.chunk)
              worker!.postMessage({ op: 'prepare-result-next', channel: data.channel, token: data.token })
            }
          } catch {
            worker?.terminate(); worker = undefined; clearCancellations()
            rejectJobs(Error('Canvas transfer stopped. Retry preparation.'))
            for (const listener of errors) listener()
          }
          return
        }
        if (data.op === 'prepare-cancelled') { clearCancellation(data.token); return }
        if (data.op === 'prepared' || data.op === 'prepare-error') {
          clearCancellation(data.token)
          const job = jobs.get(data.channel)
          if (!job || job.token !== data.token) return
          jobs.delete(data.channel)
          if (data.computeMs !== undefined) perfTrace.record('worker.geometry', data.computeMs)
          if (data.op === 'prepare-error') job.reject(Error(data.message))
          else job.resolve(job.geometry ?? data.geometry)
        } else for (const listener of listeners) listener(data)
      }
      worker.onerror = () => {
        sceneUpload = undefined
        worker?.terminate(); worker = undefined
        clearCancellations()
        rejectJobs(Error('Canvas worker stopped. Retry preparation.'))
        for (const listener of errors) listener()
      }
    } catch { worker = undefined }
    return worker
  }
  const cancel = (channel: string) => {
    const job = jobs.get(channel)
    if (!job) return
    jobs.delete(channel); job.reject(cancelled())
    // Most work yields cooperatively. A single packing primitive may still be
    // atomic; superseded work must not occupy that worker indefinitely.
    if (worker) cancellations.set(job.token, setTimeout(() => {
      worker?.terminate(); worker = undefined; clearCancellations()
      rejectJobs(Error('Previous canvas preparation did not yield. Retry to restart it.'))
      for (const listener of errors) listener()
    }, options.cancelTimeoutMs ?? 1000))
    worker?.postMessage({ op: 'cancel-prepare', channel, token: job.token })
  }
  return {
    available: () => Boolean(start()),
    notifyUnavailable() { for (const listener of errors) listener() },
    post(message: any) {
      const port = start(); if (!port) return false
      if (message.op === 'scene') {
        sceneUpload = undefined
        if (message.records) sceneRecords = message.records
        if (sceneRecords.length > 2000 || message.relationships.length > 2000) {
          const token = ++next
          sceneUpload = { token, chunks: sceneChunks({ records: sceneRecords, relationships: message.relationships }) }
          port.postMessage({ op: 'scene-start', token, scene: message.scene, trace: message.trace })
          return true
        }
      }
      port.postMessage(message); return true
    },
    subscribe(listener: (data: any) => void, onError: () => void) {
      listeners.add(listener); errors.add(onError)
      return () => { listeners.delete(listener); errors.delete(onError) }
    },
    prepare(channel: string, input: FloorGeometryInput): Promise<PreparedFloorGeometry> {
      cancel(channel)
      const token = ++next, port = start()
      return new Promise((resolve, reject) => {
        jobs.set(channel, { token, resolve, reject })
        if (port) {
          try {
            if (input.systems.length + input.files.length + input.infraNodes.length + input.layouts.length + input.dependencies.length > 2000) {
              jobs.get(channel)!.input = sceneChunks(input)
              port.postMessage({ op: 'prepare-start', channel, token, trace: perfTrace.enabled() })
            } else traceSync('worker.geometry-post', () => port.postMessage({ op: 'prepare', channel, token, input, trace: perfTrace.enabled() }), input.systems.length + input.files.length + input.infraNodes.length)
          }
          catch (error) { jobs.delete(channel); reject(error) }
          return
        }
        // A small scene can recover cooperatively. A huge worker failure must
        // not replace itself with a synchronous UI-thread layout stall.
        if (input.systems.length + input.files.length + input.infraNodes.length > 2000 || input.dependencies.length > 2000 || input.layouts.length > 2000) {
          jobs.delete(channel); reject(Error('Background canvas preparation is unavailable. Retry to restart the worker.')); return
        }
        const steps = prepareFloorGeometrySteps(input.systems, input.files, input.infraNodes, input.dependencies, input.layouts, input.placements)
        const tick = () => {
          if (jobs.get(channel)?.token !== token) return
          const deadline = performance.now() + 3
          try {
            do {
              const result = steps.next()
              if (result.done) { jobs.delete(channel); resolve(result.value); return }
            } while (performance.now() < deadline)
            setTimeout(tick, 0)
          } catch (error) { jobs.delete(channel); reject(error) }
        }
        setTimeout(tick, 0)
      })
    },
    cancel,
    stop() { sceneUpload = undefined; sceneRecords = []; worker?.terminate(); worker = undefined; attempted = false; clearCancellations(); rejectJobs(cancelled()) },
    restart() { sceneUpload = undefined; sceneRecords = []; worker?.terminate(); worker = undefined; attempted = false; clearCancellations(); rejectJobs(cancelled()) },
  }
}
