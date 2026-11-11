import type { DbFile, DbInfraNode, DbSystem } from '../../shared/types'

/**
 * ⌘K results: everything Ambio keeps that a person might look for - systems,
 * infrastructure, files, functions and classes from archd's symbol index,
 * sheets, what is drawn on them, sticky notes, agent conversations and saved
 * investigations - in that order, each group ranked exact, then prefix, then
 * contains; with no query, the map's systems and infrastructure, the sheets
 * and recent conversations to browse. Pure, so the search window only renders
 * and fetches.
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

/** A sheet, by name. */
export interface SearchSheet { id: string; name: string; purpose?: string | null }
/** Something drawn on a sheet that is not code yet. */
export interface SearchPlanned { id: string; sheetId: string; sheetName: string; name: string; kind: string }
/** A sticky note, on the Floor (sheetId null) or a sheet. */
export interface SearchNote { id: string; sheetId: string | null; sheetName: string | null; body: string }
/** An agent conversation: its title and everything said in it. */
export interface SearchConversation { id: string; title: string; said: string[]; turns: number }
/** A saved investigation. */
export interface SearchInvestigation { id: string; name: string; createdAt: number }

export type SearchResult =
  | { kind: 'system'; id: string; nodeId: string; title: string; detail: string }
  | { kind: 'infra'; id: string; nodeId: string; title: string; detail: string }
  | { kind: 'file'; id: string; nodeId: string; title: string; detail: string; file: DbFile }
  | { kind: 'symbol'; id: string; nodeId: string; title: string; detail: string; symbol: SymbolMatch }
  | { kind: 'sheet'; id: string; nodeId: string; title: string; detail: string; sheetId: string }
  | { kind: 'planned'; id: string; nodeId: string; title: string; detail: string; sheetId: string; plannedKind: string }
  | { kind: 'note'; id: string; nodeId: string; title: string; detail: string; sheetId: string | null }
  | { kind: 'conversation'; id: string; nodeId: string; title: string; detail: string; threadId: string }
  | { kind: 'investigation'; id: string; nodeId: string; title: string; detail: string; investigationId: string }

export const SEARCH_GROUP_LABELS: Record<SearchResult['kind'], string> = {
  system: 'Systems',
  infra: 'Infrastructure',
  file: 'Files',
  symbol: 'Functions and classes',
  sheet: 'Sheets',
  planned: 'Drawn on sheets',
  note: 'Notes',
  conversation: 'Conversations',
  investigation: 'Investigations',
}

/** What a row is, in a word, at its right. */
export function searchResultBadge(result: SearchResult): string {
  switch (result.kind) {
    case 'system': return 'System'
    case 'infra': return 'Infra'
    case 'file': return result.file.language || 'File'
    case 'symbol': return result.symbol.kind || 'Symbol'
    case 'sheet': return 'Sheet'
    case 'planned': return `Planned ${result.plannedKind}`.trim()
    case 'note': return 'Note'
    case 'conversation': return 'Agent'
    case 'investigation': return 'Recording'
  }
}

const LIMITS: Record<SearchResult['kind'], number> = {
  system: 8, infra: 6, file: 30, symbol: 30, sheet: 8, planned: 10, note: 10, conversation: 8, investigation: 6,
}

/** The first line of a note, without Markdown's heading and emphasis marks. */
function noteTitle(body: string): string {
  const line = body.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  return line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim() || 'Untitled note'
}

/** A few words either side of where the query was found, for a match deep in text. */
function snippet(text: string, needle: string, room = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) return ''
  const start = Math.max(0, at - room), end = Math.min(flat.length, at + needle.length + room)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

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

const BROWSE_LIMITS = { system: 24, infra: 12, sheet: 12, conversation: 6 }

/**
 * Before anything is typed: the map's systems, outermost first and then by
 * path, and its infrastructure by name, so the window opens on something to
 * pick rather than an empty box.
 */
function browseResults(
  systems: Array<Pick<DbSystem, 'id' | 'name' | 'parentId'>>,
  infraNodes: Array<Pick<DbInfraNode, 'id' | 'name' | 'provider' | 'category'>>,
  systemsById: Map<string, Pick<DbSystem, 'name' | 'parentId'>>,
): SearchResult[] {
  const browseSystems = systems
    .map(system => {
      const parents = systemPath(system.parentId, systemsById)
      return { system, parents, depth: parents ? parents.split(' › ').length : 0 }
    })
    .sort((a, b) => a.depth - b.depth || a.parents.localeCompare(b.parents) ||
      a.system.name.localeCompare(b.system.name))
    .slice(0, BROWSE_LIMITS.system)
    .map(({ system, parents }): SearchResult => ({
      kind: 'system', id: system.id, nodeId: system.id, title: system.name, detail: parents || 'Top level',
    }))
  const browseInfra = [...infraNodes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, BROWSE_LIMITS.infra)
    .map((node): SearchResult => ({
      kind: 'infra', id: node.id, nodeId: node.id, title: node.name,
      detail: [node.provider, node.category].filter(Boolean).join(', '),
    }))
  return [...browseSystems, ...browseInfra]
}

const sheetResult = (sheet: SearchSheet): SearchResult => ({
  kind: 'sheet', id: `sheet:${sheet.id}`, nodeId: '', title: sheet.name, detail: sheet.purpose?.trim() || 'Overlay sheet', sheetId: sheet.id,
})
const conversationResult = (conversation: SearchConversation, detail?: string): SearchResult => ({
  kind: 'conversation', id: `conversation:${conversation.id}`, nodeId: '', title: conversation.title || 'Untitled conversation',
  detail: detail || `${conversation.turns} ${conversation.turns === 1 ? 'message' : 'messages'}`, threadId: conversation.id,
})

export function buildSearchResults(input: {
  query: string
  systems: Array<Pick<DbSystem, 'id' | 'name' | 'parentId'>>
  infraNodes: Array<Pick<DbInfraNode, 'id' | 'name' | 'provider' | 'category'>>
  files: DbFile[]
  symbols: SymbolMatch[]
  sheets?: SearchSheet[]
  planned?: SearchPlanned[]
  notes?: SearchNote[]
  conversations?: SearchConversation[]
  investigations?: SearchInvestigation[]
}): SearchResult[] {
  const needle = input.query.trim().toLowerCase()
  const systemsById = new Map(input.systems.map(system => [system.id, system]))
  const sheets = input.sheets ?? [], conversations = input.conversations ?? []
  if (!needle) {
    return [
      ...browseResults(input.systems, input.infraNodes, systemsById),
      ...[...sheets].sort((a, b) => a.name.localeCompare(b.name)).slice(0, BROWSE_LIMITS.sheet).map(sheetResult),
      ...conversations.slice(0, BROWSE_LIMITS.conversation).map(conversation => conversationResult(conversation)),
    ]
  }
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
      detail: [node.provider, node.category].filter(Boolean).join(', '),
    }))
  // A path fragment like "canvas/Ambio" matches the path; the name ranks first.
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
      detail: `${symbol.kind}, ${symbol.relPath}:${symbol.lineStart}`, symbol,
    }))
  const sheetMatches = ranked(sheets, sheet => {
    const byName = matchRank(sheet.name, needle)
    return byName >= 0 ? byName : (sheet.purpose ?? '').toLowerCase().includes(needle) ? 3 : -1
  }, sheet => sheet.name, LIMITS.sheet).map(sheetResult)
  const planned = ranked(input.planned ?? [], item => matchRank(item.name, needle), item => item.name, LIMITS.planned)
    .map((item): SearchResult => ({
      kind: 'planned', id: `planned:${item.id}`, nodeId: `planned:${item.id}`, title: item.name,
      detail: `On ${item.sheetName}`, sheetId: item.sheetId, plannedKind: item.kind,
    }))
  // A note is found by any of its words; its first line names it.
  const notes = ranked(input.notes ?? [], note => {
    const byTitle = matchRank(noteTitle(note.body), needle)
    return byTitle >= 0 ? byTitle : note.body.toLowerCase().includes(needle) ? 3 : -1
  }, note => noteTitle(note.body), LIMITS.note)
    .map((note): SearchResult => {
      const title = noteTitle(note.body)
      const where = note.sheetName ? `On ${note.sheetName}` : 'On the Floor'
      return {
        kind: 'note', id: `note:${note.id}`, nodeId: `note:${note.id}`, title,
        detail: title.toLowerCase().includes(needle) ? where : `${where}: ${snippet(note.body, needle)}`, sheetId: note.sheetId,
      }
    })
  // A conversation is found by its title or anything said in it.
  const conversationMatches = ranked(conversations, conversation => {
    const byTitle = matchRank(conversation.title, needle)
    if (byTitle >= 0) return byTitle
    return conversation.said.some(text => text.toLowerCase().includes(needle)) ? 3 : -1
  }, conversation => conversation.title, LIMITS.conversation)
    .map(conversation => {
      const where = conversation.title.toLowerCase().includes(needle) ? undefined
        : conversation.said.map(text => snippet(text, needle)).find(Boolean)
      return conversationResult(conversation, where)
    })
  const investigations = ranked(input.investigations ?? [], item => matchRank(item.name, needle), item => item.name, LIMITS.investigation)
    .map((item): SearchResult => ({
      kind: 'investigation', id: `investigation:${item.id}`, nodeId: '', title: item.name,
      detail: `Recorded ${new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
      investigationId: item.id,
    }))
  return [...systems, ...infra, ...files, ...symbols, ...sheetMatches, ...planned, ...notes, ...conversationMatches, ...investigations]
}
