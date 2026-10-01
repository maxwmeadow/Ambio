import type { DbFile, DbInfraNode, DbSystem } from '../../shared/types'

/**
 * ⌘K results: everything on the map a name can find - systems, infrastructure,
 * files, and symbols from archd's symbol index - in that order, each group
 * ranked exact, then prefix, then contains. Pure, so the search window only
 * renders and fetches.
 */

export interface SymbolMatch {
  id: string
  fileId: string
  name: string
  kind: string
  lineStart: number
  lineEnd: number
  relPath: string
}

export type SearchResult =
  | { kind: 'system'; id: string; nodeId: string; title: string; detail: string }
  | { kind: 'infra'; id: string; nodeId: string; title: string; detail: string }
  | { kind: 'file'; id: string; nodeId: string; title: string; detail: string; file: DbFile }
  | { kind: 'symbol'; id: string; nodeId: string; title: string; detail: string; symbol: SymbolMatch }

export const SEARCH_GROUP_LABELS: Record<SearchResult['kind'], string> = {
  system: 'Systems',
  infra: 'Infrastructure',
  file: 'Files',
  symbol: 'Symbols',
}

const LIMITS: Record<SearchResult['kind'], number> = { system: 8, infra: 6, file: 30, symbol: 30 }

/** 0 exact, 1 prefix, 2 contains, -1 no match. */
function matchRank(text: string, needle: string): number {
  const lower = text.toLowerCase()
  if (lower === needle) return 0
  if (lower.startsWith(needle)) return 1
  return lower.includes(needle) ? 2 : -1
}

function ranked<T>(items: T[], score: (item: T) => number, label: (item: T) => string, limit: number): T[] {
  return items
    .map(item => ({ item, rank: score(item) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || label(a.item).length - label(b.item).length ||
      label(a.item).localeCompare(label(b.item)))
    .slice(0, limit)
    .map(entry => entry.item)
}

/** The path of systems above a system, outermost first: "Shop › Orders". */
function systemPath(systemId: string | null | undefined, byId: Map<string, Pick<DbSystem, 'name' | 'parentId'>>): string {
  const names: string[] = []
  const seen = new Set<string>()
  for (let id = systemId; id && !seen.has(id); id = byId.get(id)?.parentId) {
    seen.add(id)
    const system = byId.get(id)
    if (!system) break
    names.unshift(system.name)
  }
  return names.join(' › ')
}

export function buildSearchResults(input: {
  query: string
  systems: Array<Pick<DbSystem, 'id' | 'name' | 'parentId'>>
  infraNodes: Array<Pick<DbInfraNode, 'id' | 'name' | 'provider' | 'category'>>
  files: DbFile[]
  symbols: SymbolMatch[]
}): SearchResult[] {
  const needle = input.query.trim().toLowerCase()
  if (!needle) return []
  const systemsById = new Map(input.systems.map(system => [system.id, system]))
  const filesById = new Map(input.files.map(file => [file.id, file]))
  const fileName = (relPath: string) => relPath.split('/').pop() ?? relPath

  const systems = ranked(input.systems, system => matchRank(system.name, needle), system => system.name, LIMITS.system)
    .map((system): SearchResult => ({
      kind: 'system', id: system.id, nodeId: system.id, title: system.name,
      detail: systemPath(system.parentId, systemsById) || 'Top level',
    }))
  const infra = ranked(input.infraNodes, node => matchRank(node.name, needle), node => node.name, LIMITS.infra)
    .map((node): SearchResult => ({
      kind: 'infra', id: node.id, nodeId: node.id, title: node.name,
      detail: [node.provider, node.category].filter(Boolean).join(' · '),
    }))
  // A path fragment like "canvas/Axiom" matches the path; the name ranks first.
  const files = ranked(input.files, file => {
    const byName = matchRank(fileName(file.relPath), needle)
    if (byName >= 0) return byName
    return file.relPath.toLowerCase().includes(needle) ? 3 : -1
  }, file => file.relPath, LIMITS.file)
    .map((file): SearchResult => ({
      kind: 'file', id: file.id, nodeId: file.id, title: fileName(file.relPath), detail: file.relPath, file,
    }))
  // archd already ranked the symbols; drop any whose file the map no longer has.
  const symbols = input.symbols
    .filter(symbol => filesById.has(symbol.fileId))
    .slice(0, LIMITS.symbol)
    .map((symbol): SearchResult => ({
      kind: 'symbol', id: `symbol:${symbol.id}`, nodeId: symbol.fileId, title: symbol.name,
      detail: `${symbol.kind} · ${symbol.relPath}:${symbol.lineStart}`, symbol,
    }))
  return [...systems, ...infra, ...files, ...symbols]
}
