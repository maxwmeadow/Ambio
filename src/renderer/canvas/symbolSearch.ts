import { archdApi } from '../archdEndpoint'
import type { SymbolMatch } from './searchResults'

/**
 * Symbols by name across the whole project, ranked by archd (exact, prefix,
 * contains): the same lookup agents get from search_symbols. An unreachable
 * daemon or a bad answer finds nothing rather than failing the search.
 */
export async function searchSymbols(workspaceId: string, query: string, signal?: AbortSignal, limit = 30): Promise<SymbolMatch[]> {
  const params = new URLSearchParams({ workspace: workspaceId, q: query, limit: String(limit) })
  const response = await fetch(`${archdApi()}/api/symbols/search?${params.toString()}`, { signal })
  if (!response.ok) return []
  const body = await response.json() as { symbols?: unknown }
  return Array.isArray(body?.symbols) ? body.symbols as SymbolMatch[] : []
}
