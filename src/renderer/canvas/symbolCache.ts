import { recordSymbolCacheHit, recordSymbolDeduplication, recordSymbolFetch, getPerfMetrics } from './perfMetrics.ts'
import { archdWsHttp } from '../archdEndpoint.ts'

const MAX_REQUESTS = 4, MAX_CACHED_FILES = 512, MAX_CACHED_ROWS = 50_000, EMPTY_TTL_MS = 2000
type Symbols = any[]
interface Consumer { resolve: (rows: Symbols) => void; reject: (reason: unknown) => void; cleanup: () => void }
interface Request {
  key: string; workspaceId: string; fileId: string; baseUrl: string; version: number
  consumers: Set<Consumer>; controller: AbortController; started: boolean; priority: boolean
}
const cache = new Map<string, { rows: Symbols; expires: number }>(), versions = new Map<string, number>()
const requests = new Map<string, Request>(), queue: Request[] = []
let active = 0
const keyFor = (workspaceId: string, fileId: string) => workspaceId + ':' + fileId
const aborted = () => new DOMException('Symbol request cancelled', 'AbortError')

export function getCachedSymbols(workspaceId: string, fileId: string): Symbols | null {
  const key = keyFor(workspaceId, fileId), entry = cache.get(key)
  if (!entry) return null
  if (entry.expires < Date.now()) { cache.delete(key); return null }
  cache.delete(key); cache.set(key, entry); recordSymbolCacheHit()
  return entry.rows
}
export function setCachedSymbols(workspaceId: string, fileId: string, rows: Symbols): void {
  const key = keyFor(workspaceId, fileId)
  cache.delete(key); cache.set(key, { rows, expires: rows.length ? Infinity : Date.now() + EMPTY_TTL_MS })
  let total = 0
  for (const entry of cache.values()) total += entry.rows.length
  while (cache.size > MAX_CACHED_FILES || total > MAX_CACHED_ROWS) {
    const oldest = cache.keys().next().value!
    total -= cache.get(oldest)!.rows.length; cache.delete(oldest)
  }
}
function cancel(request: Request) {
  request.controller.abort()
  for (const consumer of request.consumers) { consumer.cleanup(); consumer.reject(aborted()) }
  request.consumers.clear()
  if (requests.get(request.key) === request) requests.delete(request.key)
  const position = queue.indexOf(request)
  if (position >= 0) queue.splice(position, 1)
}
export function forgetFileSymbols(workspaceId: string, fileId: string): void {
  const key = keyFor(workspaceId, fileId)
  cache.delete(key); versions.set(key, (versions.get(key) ?? 0) + 1)
  const request = requests.get(key)
  if (request) cancel(request)
}
export function clearSymbolCache(workspaceId?: string): void {
  const matches = (key: string) => !workspaceId || key.startsWith(workspaceId + ':')
  for (const key of cache.keys()) if (matches(key)) cache.delete(key)
  for (const request of requests.values()) if (matches(request.key)) cancel(request)
  for (const key of versions.keys()) if (matches(key)) versions.delete(key)
}
function pump() {
  while (active < MAX_REQUESTS && queue.length) {
    const request = queue.shift()!
    if (!request.consumers.size || request.controller.signal.aborted) continue
    request.started = true; active++
    const metrics = getPerfMetrics()
    metrics.activeSymbolRequests = active; metrics.maxSymbolRequests = Math.max(metrics.maxSymbolRequests, active)
    recordSymbolFetch()
    void (async () => {
      try {
        const response = await fetch(request.baseUrl + '/api/files/' + request.fileId + '/symbols?workspace=' + encodeURIComponent(request.workspaceId),
          { signal: request.controller.signal })
        if (!response.ok) throw new Error('symbols request failed with status ' + response.status)
        const body = await response.json(), rows = Array.isArray(body) ? body : []
        if (!request.controller.signal.aborted && (versions.get(request.key) ?? 0) === request.version && requests.get(request.key) === request)
          setCachedSymbols(request.workspaceId, request.fileId, rows)
        for (const consumer of request.consumers) { consumer.cleanup(); consumer.resolve(rows) }
      } catch (error) {
        for (const consumer of request.consumers) { consumer.cleanup(); consumer.reject(error) }
      } finally {
        request.consumers.clear()
        if (requests.get(request.key) === request) requests.delete(request.key)
        active--; metrics.activeSymbolRequests = active; pump()
      }
    })()
  }
}
/** Each consumer owns cancellation. Unmounting one card cannot abort another
 * card or the destination prefetch sharing the same HTTP request. */
export function fetchFileSymbols(workspaceId: string, fileId: string, signal?: AbortSignal,
  baseUrl = archdWsHttp(), priority = true): Promise<Symbols> {
  if (signal?.aborted) return Promise.reject(aborted())
  const cached = getCachedSymbols(workspaceId, fileId)
  if (cached) return Promise.resolve(cached)
  const key = keyFor(workspaceId, fileId)
  let request = requests.get(key)
  if (request) recordSymbolDeduplication()
  else {
    request = { key, workspaceId, fileId, baseUrl, version: versions.get(key) ?? 0,
      consumers: new Set(), controller: new AbortController(), started: false, priority }
    requests.set(key, request)
    if (priority) queue.unshift(request); else queue.push(request)
  }
  if (priority && !request.started && !request.priority) {
    request.priority = true; queue.splice(queue.indexOf(request), 1); queue.unshift(request)
  }
  const shared = request
  const promise = new Promise<Symbols>((resolve, reject) => {
    const consumer: Consumer = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) }
    function onAbort() {
      shared.consumers.delete(consumer); consumer.cleanup(); reject(aborted())
      if (!shared.consumers.size) cancel(shared)
    }
    signal?.addEventListener('abort', onAbort, { once: true }); shared.consumers.add(consumer)
  })
  pump()
  return promise
}
