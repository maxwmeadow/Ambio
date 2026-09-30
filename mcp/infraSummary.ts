/**
 * The infra layer as an agent reads it (get_architecture scope "infra").
 *
 * Raw rows are ids and joins; an agent reading them spends turns resolving
 * what a person would see at a glance. This renders each node as the plan
 * describes it (docs/INFRA.md): role and what fills it locally, what it
 * needs to run, who touches it and how, and its contract - with file paths,
 * and with the next action where one is due (a proposal to decide, a "uses"
 * that could say READS or WRITES).
 */

export interface SummaryNode {
  id: string
  name: string
  category: string
  subtype?: string
  service?: string
  status?: string
  implementations?: Array<{ environment: string; kind: string; ref: string }>
}

export interface SummaryEdge {
  src: string
  dst: string
  srcType: string
  dependencyType: string
  targetItem?: string
  status?: string
}

export interface SummaryInput {
  nodes: SummaryNode[]
  edges: SummaryEdge[]
  contents: Array<{ infraId: string; kind: string; name: string; detail?: Record<string, unknown> }>
  requirements: Array<{ name: string; infraId?: string | null; present: boolean }>
  unresolved: Array<{ Package: string; Candidates: string[]; Evidence: string }>
  /** Relationship kinds each role accepts (category → kinds). */
  edgeKinds?: Record<string, string[]>
  /** file or system id → path or name. */
  nameOf: (id: string) => string
  status?: string
}

const CONTENT_LABEL: Record<string, string> = {
  hosts: 'Runs the folders',
  key_pattern: 'Cache keys',
  topic: 'Topics',
  table: 'Tables',
  collection: 'Collections',
  flag: 'Flag keys',
  model: 'Models',
  schedule: 'Schedules',
}

const KIND_LABEL: Record<string, string> = {
  'in-process': 'in-process stand-in',
  'local-service': 'local service',
  emulator: 'emulator',
  vendor: 'vendor SDK',
}

function list(names: string[], max = 8): string {
  const unique = [...new Set(names)]
  return unique.length > max ? `${unique.slice(0, max).join(', ')} (+${unique.length - max} more)` : unique.join(', ')
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function describeImplementation(impl: { kind: string; ref: string }): string {
  const ref = impl.ref.startsWith('compose:') ? `${impl.ref.slice(8)} (docker compose)` : impl.ref
  return `${ref} - ${KIND_LABEL[impl.kind] ?? impl.kind}`
}

export function infraSummary(input: SummaryInput): string {
  const nodes = input.nodes
    .filter(node => node.status !== 'dismissed')
    .filter(node => !input.status || node.status === input.status)
  if (nodes.length === 0 && input.unresolved.length === 0) {
    return input.status
      ? `No ${input.status} infrastructure.`
      : 'No infrastructure recorded or detected yet. Detection runs as files are saved; record what you find with edit_infra create.'
  }
  const proposed = nodes.filter(node => node.status === 'proposed').length
  const lines: string[] = [`Infrastructure: ${nodes.length} node${nodes.length === 1 ? '' : 's'}${proposed ? `, ${proposed} proposed by detection` : ''}.`]
  const sorted = [...nodes].sort((a, b) =>
    (a.status === 'proposed' ? 1 : 0) - (b.status === 'proposed' ? 1 : 0) || a.name.localeCompare(b.name))
  let usesOnly = 0
  for (const node of sorted) {
    const role = [node.category, node.subtype].filter(Boolean).join(', ')
    lines.push('')
    lines.push(`${node.name} - ${role}${node.service ? ` (${node.service})` : ''}${node.status === 'proposed' ? ' - PROPOSED' : ''} - id ${node.id}`)
    const local = (node.implementations ?? []).filter(impl => impl.environment === 'local')
    if (local.length > 0) lines.push(`  Locally: ${local.map(describeImplementation).join('; ')}`)
    const needs = input.requirements.filter(req => req.infraId === node.id)
    if (needs.length > 0) {
      lines.push(`  Needs: ${needs.map(req => `${req.name}${req.present ? '' : ' (not set locally)'}`).join(', ')}`)
    }
    const edges = input.edges.filter(edge => edge.dst === node.id && edge.status !== 'dismissed')
    const byKind = new Map<string, SummaryEdge[]>()
    for (const edge of edges) {
      const key = edge.targetItem ? `${edge.dependencyType} ${edge.targetItem}` : edge.dependencyType
      byKind.set(key, [...(byKind.get(key) ?? []), edge])
    }
    const keys = [...byKind.keys()].sort((a, b) =>
      (a === 'IMPLEMENTS' ? -1 : 0) - (b === 'IMPLEMENTS' ? -1 : 0) || (a === 'USES' ? 1 : 0) - (b === 'USES' ? 1 : 0) || a.localeCompare(b))
    for (const key of keys) {
      const group = byKind.get(key)!
      const label = key === 'IMPLEMENTS' ? 'Implemented by' : key === 'USES' ? 'Uses (from imports)' : key.charAt(0) + key.slice(1).toLowerCase().replace('_', ' ')
      lines.push(`  ${label}: ${list(group.map(edge => input.nameOf(edge.src)))}`)
      if (key === 'USES') usesOnly++
    }
    if (edges.length === 0) lines.push('  No file is connected to it yet.')
    const recordable = (input.edgeKinds?.[node.category] ?? []).filter(kind => kind !== 'IMPLEMENTS' && kind !== 'USES')
    if (recordable.length > 0) lines.push(`  Record as: ${recordable.join(', ')}`)
    const items = input.contents.filter(item => item.infraId === node.id)
    const itemKinds = [...new Set(items.map(item => item.kind))]
    for (const kind of itemKinds) {
      lines.push(`  ${CONTENT_LABEL[kind] ?? `${kind.replace('_', ' ')}s`}: ${list(items.filter(item => item.kind === kind).map(item =>
        typeof item.detail?.cron === 'string' ? `${item.name} (${item.detail.cron})` : item.name), 12)}`)
    }
    // A contract gap is often the bug itself: a topic sent with nobody listening.
    for (const item of items) {
      if (typeof item.detail?.warning !== 'string') continue
      const who = [...asStrings(item.detail.publishers), ...asStrings(item.detail.consumers)]
      lines.push(`  ! ${item.kind} ${item.name}: ${item.detail.warning}${who.length ? ` (${list(who, 3)})` : ''}`)
    }
  }
  const unclaimed = input.requirements.filter(req => !req.infraId).map(req => req.name)
  if (unclaimed.length > 0) {
    lines.push('')
    lines.push(`Env vars no infra claims: ${list(unclaimed, 16)}`)
  }
  if (input.unresolved.length > 0) {
    lines.push('')
    lines.push('Detection could not tell which service these are:')
    for (const item of input.unresolved) lines.push(`  ${item.Package} in ${item.Evidence} - one of ${item.Candidates.join(', ')}`)
  }
  const next: string[] = []
  if (proposed > 0) next.push('confirm or dismiss proposals once you have read the code: edit_infra {op:"decide", id, status}')
  if (usesOnly > 0) next.push('when you know how a file uses a node, record it: edit_infra {op:"connect", id, src, kind:"WRITES", item:"bookings"}')
  if (next.length > 0) {
    lines.push('')
    lines.push(`Next: ${next.join('; ')}.`)
  }
  return lines.join('\n')
}

/**
 * Contract gaps detection found (a topic published with nobody consuming it),
 * as lines to put in front of an agent that has just started debugging. They
 * are often the bug itself, and cost nothing to mention.
 */
export function infraGaps(input: Pick<SummaryInput, 'nodes' | 'contents'>, max = 5): string[] {
  const nameOf = new Map(input.nodes.filter(node => node.status !== 'dismissed').map(node => [node.id, node.name]))
  const gaps = input.contents.filter(item => nameOf.has(item.infraId) && typeof item.detail?.warning === 'string')
    .sort((a, b) => (b.detail?.similar ? 1 : 0) - (a.detail?.similar ? 1 : 0))
  // A typo shows up on both sides (receipts published, receipt consumed);
  // say it once.
  const said = new Set<string>()
  const lines: string[] = []
  for (const item of gaps) {
    const similar = typeof item.detail?.similar === 'string' ? item.detail.similar : null
    if (similar && said.has(`${item.infraId}:${similar}`)) continue
    said.add(`${item.infraId}:${item.name}`)
    const who = [...asStrings(item.detail?.publishers), ...asStrings(item.detail?.consumers),
      ...asStrings(item.detail?.readers), ...asStrings(item.detail?.invalidators)]
    const label = (CONTENT_LABEL[item.kind] ?? item.kind).toLowerCase().replace(/s$/, '')
    lines.push(`${nameOf.get(item.infraId)} ${label} "${item.name}": ${item.detail!.warning}${who.length ? ` (${list(who, 3)})` : ''}`)
  }
  const shown = lines.slice(0, max)
  if (lines.length > max) shown.push(`+${lines.length - max} more: get_architecture scope "infra"`)
  return shown
}
