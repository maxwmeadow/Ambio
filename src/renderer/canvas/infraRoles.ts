/**
 * Words for the infra layer, shared by the tray, the inspector and the canvas
 * so a role reads the same wherever it appears (docs/INFRA.md "Roles").
 */

export const ROLE_LABEL: Record<string, string> = {
  database: 'Database',
  cache: 'Cache',
  queue: 'Queue',
  storage: 'Storage',
  search: 'Search',
  llm: 'LLM',
  api: 'External API',
  auth: 'Auth',
  platform: 'Hosting',
  observability: 'Observability',
  email: 'Email',
  scheduler: 'Scheduled jobs',
  flags: 'Feature flags',
  realtime: 'Realtime',
}

/** How each implementation kind is said to a person. */
export const IMPLEMENTATION_LABEL: Record<string, string> = {
  'in-process': 'in-process stand-in',
  'local-service': 'local service',
  emulator: 'local emulator',
  vendor: 'vendor SDK',
}

/** Relationship kinds as verbs, for "who touches it". */
export const RELATIONSHIP_LABEL: Record<string, string> = {
  IMPLEMENTS: 'Implemented by',
  USES: 'Used by',
  READS: 'Read by',
  WRITES: 'Written by',
  MIGRATES: 'Migrated by',
  INVALIDATES: 'Invalidated by',
  PUBLISHES: 'Publishers',
  CONSUMES: 'Consumers',
  SUBSCRIBES: 'Subscribers',
  QUERIES: 'Queried by',
  INDEXES: 'Indexed by',
  CALLS: 'Called by',
  HANDLES_WEBHOOK: 'Webhooks handled by',
  AUTHENTICATES_VIA: 'Authenticates',
  PROTECTS: 'Protects',
  DEPLOYS_TO: 'Deploys',
  RUNS_ON: 'Runs',
  REPORTS_TO: 'Reports from',
  CAPTURES: 'Errors captured by',
  SENDS_VIA: 'Mail sent by',
  SCHEDULED_BY: 'Runs on schedule',
  EVALUATES: 'Evaluated by',
}

/** What one file is to an item it touches: "2 writers · 3 readers". */
export const ITEM_ROLE: Record<string, [string, string]> = {
  WRITES: ['writer', 'writers'],
  READS: ['reader', 'readers'],
  MIGRATES: ['migration', 'migrations'],
  INVALIDATES: ['invalidator', 'invalidators'],
  PUBLISHES: ['publisher', 'publishers'],
  CONSUMES: ['consumer', 'consumers'],
  SUBSCRIBES: ['subscriber', 'subscribers'],
}

/** Display order: what fills the role, then who uses it, most specific first. */
export const RELATIONSHIP_ORDER = [
  'IMPLEMENTS', 'WRITES', 'READS', 'MIGRATES', 'INVALIDATES', 'PUBLISHES', 'CONSUMES',
  'SUBSCRIBES', 'CALLS', 'HANDLES_WEBHOOK', 'QUERIES', 'INDEXES', 'SENDS_VIA', 'CAPTURES',
  'REPORTS_TO', 'EVALUATES', 'AUTHENTICATES_VIA', 'PROTECTS', 'SCHEDULED_BY', 'DEPLOYS_TO',
  'RUNS_ON', 'USES',
]

export interface DetectedBy {
  evidence?: Array<{ signal: string; ref: string; detail?: string }>
  declaredOnly?: boolean
  /** Which of several nodes of one service this is (one per Dockerfile). */
  instance?: string
}

export function readDetectedBy(raw: unknown): DetectedBy {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as DetectedBy } catch { return {} }
  }
  return raw as DetectedBy
}

export function fileName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

/** An infra card's authored size. */
export const INFRA_CARD_SIZE = { width: 260, height: 160 }
/** A platform frame's authored size: roomy enough to drop a system into. */
export const PLATFORM_FRAME_SIZE = { width: 480, height: 300 }
