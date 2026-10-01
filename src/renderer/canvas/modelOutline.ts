import type { DbFile, DbSymbol, DbSystem } from '../../shared/types'

/**
 * The Model Explorer's tree: systems (nested) → files → symbols, flattened to
 * the rows currently shown. Pure, so the panel only renders and the rules
 * live here (and are tested).
 */
export interface OutlineRow {
  /** Node id on the canvas; a symbol row uses `fileId::name`. */
  id: string
  kind: 'system' | 'file' | 'symbol' | 'unsorted'
  label: string
  depth: number
  /** The canvas node to select for this row (a symbol selects its file). */
  nodeId: string | null
  expandable: boolean
  expanded: boolean
  detail?: string
}

export const UNSORTED_ID = 'outline:unsorted'

export interface OutlineInput {
  systems: DbSystem[]
  files: DbFile[]
  /** Loaded symbols by file id; files without an entry show none yet. */
  symbols: Map<string, DbSymbol[]>
  expanded: Set<string>
  query: string
}

const baseName = (relPath: string) => relPath.split('/').pop() ?? relPath

export function buildOutline({ systems, files, symbols, expanded, query }: OutlineInput): OutlineRow[] {
  const needle = query.trim().toLowerCase()
  const known = new Set(systems.map(system => system.id))
  const childSystems = new Map<string | null, DbSystem[]>()
  for (const system of systems) {
    const parent = system.parentId && known.has(system.parentId) ? system.parentId : null
    childSystems.set(parent, [...(childSystems.get(parent) ?? []), system])
  }
  const filesOf = new Map<string | null, DbFile[]>()
  for (const file of files) {
    const owner = file.systemId && known.has(file.systemId) ? file.systemId : null
    filesOf.set(owner, [...(filesOf.get(owner) ?? []), file])
  }
  const byName = <T,>(label: (item: T) => string) => (a: T, b: T) => label(a).localeCompare(label(b))
  for (const list of childSystems.values()) list.sort(byName((system: DbSystem) => system.name))
  for (const list of filesOf.values()) list.sort(byName((file: DbFile) => file.relPath))

  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const symbolMatches = (file: DbFile) => (symbols.get(file.id) ?? []).filter(symbol => matches(symbol.name))
  const fileMatches = (file: DbFile) => matches(file.relPath) || (needle !== '' && symbolMatches(file).length > 0)
  // A system is shown when it, a file in it, or a system inside it matches.
  const memo = new Map<string, boolean>()
  const systemMatches = (system: DbSystem): boolean => {
    const cached = memo.get(system.id)
    if (cached !== undefined) return cached
    memo.set(system.id, false) // guards a parent cycle
    const result = matches(system.name) ||
      (filesOf.get(system.id) ?? []).some(fileMatches) ||
      (childSystems.get(system.id) ?? []).some(systemMatches)
    memo.set(system.id, result)
    return result
  }
  // While searching, everything leading to a match is open.
  const isOpen = (id: string) => needle !== '' || expanded.has(id)

  const rows: OutlineRow[] = []
  const addFile = (file: DbFile, depth: number) => {
    const fileSymbols = symbols.get(file.id)
    const shownSymbols = needle && !matches(file.relPath) ? symbolMatches(file) : fileSymbols ?? []
    const open = expanded.has(file.id) || (needle !== '' && shownSymbols.length > 0 && !matches(file.relPath))
    rows.push({
      id: file.id, kind: 'file', label: baseName(file.relPath), detail: file.relPath, depth,
      nodeId: file.id, expandable: fileSymbols === undefined || fileSymbols.length > 0, expanded: open,
    })
    if (!open) return
    for (const symbol of shownSymbols) {
      rows.push({
        id: `${file.id}::${symbol.name}::${symbol.lineStart}`, kind: 'symbol', label: symbol.name,
        detail: symbol.kind, depth: depth + 1, nodeId: file.id, expandable: false, expanded: false,
      })
    }
  }
  const addSystem = (system: DbSystem, depth: number) => {
    if (!systemMatches(system)) return
    const open = isOpen(system.id)
    const children = childSystems.get(system.id) ?? []
    const own = filesOf.get(system.id) ?? []
    rows.push({
      id: system.id, kind: 'system', label: system.name, depth, nodeId: system.id,
      expandable: children.length + own.length > 0, expanded: open,
      detail: `${own.length} file${own.length === 1 ? '' : 's'}`,
    })
    if (!open) return
    for (const child of children) addSystem(child, depth + 1)
    for (const file of own) if (fileMatches(file) || matches(system.name)) addFile(file, depth + 1)
  }
  for (const system of childSystems.get(null) ?? []) addSystem(system, 0)

  const unsorted = (filesOf.get(null) ?? []).filter(fileMatches)
  if (unsorted.length > 0) {
    const open = isOpen(UNSORTED_ID)
    rows.push({
      id: UNSORTED_ID, kind: 'unsorted', label: 'Unsorted', depth: 0, nodeId: null,
      expandable: true, expanded: open, detail: `${unsorted.length} file${unsorted.length === 1 ? '' : 's'}`,
    })
    if (open) for (const file of unsorted) addFile(file, 1)
  }
  return rows
}
