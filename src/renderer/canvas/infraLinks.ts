import type { DbDependency } from '../../shared/types.ts'

/**
 * The relationships the infrastructure sidebar draws onto the canvas
 * (docs/INFRA.md, "Canvas placement"). Infra code talks to is not on the
 * canvas; it is a row in the sidebar. Selecting a row draws a line from it to
 * every visible box that touches it; selecting a system or file while the
 * sidebar is open draws a line from that box back to each row it touches.
 * Pure, so the merging and wording are tested without a canvas.
 */
export interface InfraLink {
  key: string
  /** The visible canvas box the line meets. */
  nodeId: string
  /** The sidebar row the line meets. */
  infraId: string
  kinds: string[]
  /** Distinct files behind the line. */
  files: number
  label: string
  /** Only USES / IMPLEMENTS are known: drawn as a quieter, dashed line. */
  generic: boolean
}

const WORD: Record<string, string> = {
  READS: 'reads', WRITES: 'writes', MIGRATES: 'migrates', INVALIDATES: 'invalidates',
  PUBLISHES: 'publishes', CONSUMES: 'consumes', SUBSCRIBES: 'subscribes', QUERIES: 'queries',
  INDEXES: 'indexes', CALLS: 'calls', HANDLES_WEBHOOK: 'webhooks', AUTHENTICATES_VIA: 'auth',
  PROTECTS: 'protects', DEPLOYS_TO: 'deploys', RUNS_ON: 'runs on', REPORTS_TO: 'reports',
  CAPTURES: 'captures', SENDS_VIA: 'sends', SCHEDULED_BY: 'scheduled', EVALUATES: 'evaluates',
  IMPLEMENTS: 'implements', USES: 'uses',
}

// Most consequential first: a writer matters more than a reader.
const SPECIFIC_FIRST = [
  'WRITES', 'MIGRATES', 'PUBLISHES', 'INVALIDATES', 'SENDS_VIA', 'CALLS', 'HANDLES_WEBHOOK',
  'READS', 'CONSUMES', 'SUBSCRIBES', 'QUERIES', 'INDEXES', 'CAPTURES', 'REPORTS_TO', 'EVALUATES',
  'AUTHENTICATES_VIA', 'PROTECTS', 'SCHEDULED_BY', 'DEPLOYS_TO', 'RUNS_ON', 'IMPLEMENTS', 'USES',
]

export interface InfraLinkInput {
  /** A sidebar row is selected: draw who touches it. */
  selectedInfraId: string | null
  /** Otherwise a canvas box is selected: draw what it touches. */
  selectedNodeId: string | null
  dependencies: readonly DbDependency[]
  /** Rows the sidebar lists (anything not dismissed). */
  infraIds: ReadonlySet<string>
  /** file id → its system, and system id → its parent. */
  fileSystem: ReadonlyMap<string, string | null>
  systemParent: ReadonlyMap<string, string | null>
  /** Resolves any node id to the box actually drawn for it. */
  visibleNodeId: (id: string) => string | null
}

function withinSelection(srcId: string, srcType: string, selectedId: string, input: InfraLinkInput): boolean {
  if (srcId === selectedId) return true
  let systemId = srcType === 'system' ? input.systemParent.get(srcId) ?? null : input.fileSystem.get(srcId) ?? null
  const seen = new Set<string>()
  while (systemId && !seen.has(systemId)) {
    if (systemId === selectedId) return true
    seen.add(systemId)
    systemId = input.systemParent.get(systemId) ?? null
  }
  return false
}

export function infraLinks(input: InfraLinkInput): InfraLink[] {
  const { selectedInfraId, selectedNodeId } = input
  if (!selectedInfraId && !selectedNodeId) return []
  const groups = new Map<string, { nodeId: string; infraId: string; kinds: Set<string>; files: Set<string> }>()
  for (const dep of input.dependencies) {
    if (dep.dstType !== 'infra' || dep.status === 'dismissed' || !input.infraIds.has(dep.dst)) continue
    let nodeId: string | null
    if (selectedInfraId) {
      if (dep.dst !== selectedInfraId) continue
      nodeId = input.visibleNodeId(dep.src)
    } else {
      if (!withinSelection(dep.src, dep.srcType, selectedNodeId!, input)) continue
      nodeId = input.visibleNodeId(selectedNodeId!)
    }
    if (!nodeId) continue
    const key = `${nodeId}>${dep.dst}`
    const group = groups.get(key) ?? { nodeId, infraId: dep.dst, kinds: new Set<string>(), files: new Set<string>() }
    group.kinds.add(dep.dependencyType)
    group.files.add(dep.src)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, group]) => {
    const specific = [...group.kinds].filter(kind => kind !== 'USES' && kind !== 'IMPLEMENTS')
    const shown = (specific.length > 0 ? specific : [...group.kinds])
      .sort((a, b) => SPECIFIC_FIRST.indexOf(a) - SPECIFIC_FIRST.indexOf(b))
    const words = shown.slice(0, 3).map(kind => WORD[kind] ?? kind.toLowerCase())
    const count = group.files.size
    return {
      key,
      nodeId: group.nodeId,
      infraId: group.infraId,
      kinds: [...group.kinds],
      files: count,
      label: count > 1 ? `${words.join(' · ')} · ${count} files` : words.join(' · '),
      generic: specific.length === 0,
    }
  })
}
