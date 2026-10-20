import {
  recordSymbolCacheHit,
  recordSymbolDeduplication,
  recordSymbolFetch,
} from './perfMetrics.ts'
import { archdWsHttp } from '../archdEndpoint.ts'

/** In-memory cache for file symbols keyed by `${workspaceId}:${fileId}` */
const symbolCache = new Map<string, any[]>()

/** In-flight request promises for deduplicating concurrent fetches */
const inFlightRequests = new Map<string, Promise<any[]>>()

function cacheKey(workspaceId: string, fileId: string): string {
  return `${workspaceId}:${fileId}`
}

export function getCachedSymbols(workspaceId: string, fileId: string): any[] | null {
  const key = cacheKey(workspaceId, fileId)
  const cached = symbolCache.get(key)
  if (cached) {
    recordSymbolCacheHit()
    return cached
  }
  return null
}

export function setCachedSymbols(workspaceId: string, fileId: string, symbols: any[]): void {
  const key = cacheKey(workspaceId, fileId)
  symbolCache.set(key, symbols)
}

/** A file's symbols changed (it was re-indexed); the next look fetches them again. */
export function forgetFileSymbols(workspaceId: string, fileId: string): void {
  symbolCache.delete(cacheKey(workspaceId, fileId))
}

export function clearSymbolCache(workspaceId?: string): void {
  if (!workspaceId) {
    symbolCache.clear()
    inFlightRequests.clear()
    return
  }
  const prefix = `${workspaceId}:`
  for (const key of symbolCache.keys()) {
    if (key.startsWith(prefix)) symbolCache.delete(key)
  }
  for (const key of inFlightRequests.keys()) {
    if (key.startsWith(prefix)) inFlightRequests.delete(key)
  }
}

export async function fetchFileSymbols(
  workspaceId: string,
  fileId: string,
  signal?: AbortSignal,
  baseUrl = `${archdWsHttp()}`,
): Promise<any[]> {
  const key = cacheKey(workspaceId, fileId)

  // 1. Synchronous cache hit
  const cached = symbolCache.get(key)
  if (cached) {
    recordSymbolCacheHit()
    return cached
  }

  // 2. In-flight request deduplication
  const inFlight = inFlightRequests.get(key)
  if (inFlight) {
    recordSymbolDeduplication()
    return inFlight
  }

  // 3. Dispatch new network fetch
  recordSymbolFetch()
  const requestPromise = (async () => {
    try {
      const url = `${baseUrl}/api/files/${fileId}/symbols?workspace=${encodeURIComponent(workspaceId)}`
      const res = await fetch(url, { signal })
      if (!res.ok) throw new Error(`symbols request failed with status ${res.status}`)
      const data = await res.json()
      const symbols = Array.isArray(data) ? data : []
      // An empty answer can mean the file is not indexed yet; it is not kept,
      // or a card that looked early would say "No symbols" for the session.
      if (symbols.length) symbolCache.set(key, symbols)
      return symbols
    } finally {
      inFlightRequests.delete(key)
    }
  })()

  inFlightRequests.set(key, requestPromise)
  return requestPromise
}
