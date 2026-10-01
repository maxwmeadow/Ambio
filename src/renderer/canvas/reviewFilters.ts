import type { DeltaClaim, DeltaWorkSession } from '../../shared/types'

/**
 * Narrowing Review Changes when a lot happened: by who made a change (you, an
 * agent, or an agent that never said why), by the work it belongs to, by kind,
 * and by system. Pure, so the panel only renders the choices.
 */
export interface ReviewFilter {
  who: string // '' | 'human' | 'unexplained' | 'agent:<name>'
  work: string // '' | session id
  kind: string // '' | ReviewKindGroup
  system: string // '' | system id
  hideSeen: boolean
}

export const NO_FILTER: ReviewFilter = { who: '', work: '', kind: '', system: '', hideSeen: false }

export type ReviewKindGroup = 'meaning' | 'dependencies' | 'systems' | 'files'

export const KIND_GROUP_LABELS: Record<ReviewKindGroup, string> = {
  meaning: 'Map changes',
  dependencies: 'Dependencies',
  systems: 'Systems',
  files: 'Files',
}

export function kindGroup(kind: string): ReviewKindGroup {
  if (kind.startsWith('meaning.')) return 'meaning'
  if (kind.startsWith('file.')) return 'files'
  if (kind === 'system.coupling' || kind === 'system.decoupling' || kind === 'system.hub' || kind === 'system.orphaned') {
    return 'dependencies'
  }
  return 'systems'
}

interface FilterContext {
  sessions: ReadonlyMap<string, Pick<DeltaWorkSession, 'agent'>>
  /** file id → system id, to place a claim that names only files. */
  systemOfFile: ReadonlyMap<string, string | null | undefined>
}

function agentOf(claim: DeltaClaim, context: FilterContext): string {
  return (claim.sessionId && context.sessions.get(claim.sessionId)?.agent) || 'agent'
}

function claimSystems(claim: DeltaClaim, context: FilterContext): Set<string> {
  const systems = new Set(claim.focusSystemIds ?? [])
  for (const fileId of claim.focusFileIds ?? []) {
    const system = context.systemOfFile.get(fileId)
    if (system) systems.add(system)
  }
  return systems
}

export function claimMatches(claim: DeltaClaim, filter: ReviewFilter, context: FilterContext, seen: ReadonlySet<string>): boolean {
  if (filter.hideSeen && seen.has(claim.id)) return false
  if (filter.who === 'human' && claim.actor === 'agent') return false
  if (filter.who === 'unexplained' && !(claim.actor !== 'human' && !claim.sessionId)) return false
  if (filter.who.startsWith('agent:') && (claim.actor === 'human' || agentOf(claim, context) !== filter.who.slice(6))) return false
  if (filter.work && claim.sessionId !== filter.work) return false
  if (filter.kind && kindGroup(claim.kind) !== filter.kind) return false
  if (filter.system && !claimSystems(claim, context).has(filter.system)) return false
  return true
}

export interface FilterOption { value: string; label: string; count: number }

/** The choices worth offering: only values some claim has, with counts. */
export function reviewFilterOptions(
  claims: DeltaClaim[],
  context: FilterContext & {
    sessionGoals: ReadonlyMap<string, string>
    systemNames: ReadonlyMap<string, string>
  },
): { who: FilterOption[]; work: FilterOption[]; kind: FilterOption[]; system: FilterOption[] } {
  const tally = (entries: Array<[string, string]>) => {
    const counts = new Map<string, FilterOption>()
    for (const [value, label] of entries) {
      const option = counts.get(value) ?? { value, label, count: 0 }
      option.count++
      counts.set(value, option)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }
  const who: Array<[string, string]> = []
  const work: Array<[string, string]> = []
  const kind: Array<[string, string]> = []
  const system: Array<[string, string]> = []
  for (const claim of claims) {
    if (claim.actor !== 'agent') who.push(['human', 'You'])
    if (claim.actor !== 'human') {
      const agent = agentOf(claim, context)
      who.push([`agent:${agent}`, agent === 'agent' ? 'Agents' : agent])
      if (!claim.sessionId) who.push(['unexplained', 'Unexplained'])
    }
    if (claim.sessionId) work.push([claim.sessionId, context.sessionGoals.get(claim.sessionId) || 'Agent session'])
    const group = kindGroup(claim.kind)
    kind.push([group, KIND_GROUP_LABELS[group]])
    for (const id of claimSystems(claim, context)) {
      const name = context.systemNames.get(id)
      if (name) system.push([id, name])
    }
  }
  return { who: tally(who), work: tally(work), kind: tally(kind), system: tally(system) }
}

export function isFiltered(filter: ReviewFilter): boolean {
  return Boolean(filter.who || filter.work || filter.kind || filter.system || filter.hideSeen)
}
