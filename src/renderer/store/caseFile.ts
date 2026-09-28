/**
 * The case file: an investigation as the person watching sees it.
 *
 * archd broadcasts each step of an agent's investigation (a hypothesis, a run
 * and its evidence, a verdict, a note, the conclusion, a message from the
 * human) as an `investigation:*` event, and records the same events into the
 * saved capture. This module folds those events into the state the case panel
 * renders. Because replay re-dispatches the captured events through the same
 * handler, watching live, joining halfway and replaying a saved case are one
 * code path.
 *
 * Pure: no store, no DOM. Tested in caseFile.test.mjs.
 */

export interface CaseAnchor {
  fileId?: string
  relPath?: string
  symbol?: string
  line?: number
}

export type HypothesisStatus = 'open' | 'confirmed' | 'refuted' | 'inconclusive'

export interface CaseHypothesis {
  id: string
  text: string
  anchors?: CaseAnchor[]
  status: HypothesisStatus
  verdict?: string
  runIds?: string[]
  createdAt: number
  decidedAt?: number
}

export interface CaseFinding {
  kind: string
  severity: 'high' | 'medium' | 'info'
  text: string
  anchor?: CaseAnchor
}

export interface CaseSample {
  call: number
  args: string
  returned?: string
  threw?: string
  mutated?: string[]
}

export interface CaseWatched {
  anchor: CaseAnchor
  calls: number
  errors: number
  returns?: string
  samples?: CaseSample[]
}

export interface CaseCall {
  fromFileId: string
  fromSymbol: string
  toFileId: string
  toSymbol: string
  calls: number
}

export interface CaseRun {
  id: string
  n: number
  command: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  hypothesisId?: string
  headline: string
  findings: CaseFinding[]
  watched: CaseWatched[]
  calls: CaseCall[]
  functionsRun?: number
  filesRun?: number
  outputTail?: string
  error?: string
}

export interface CaseMessage {
  id: string
  text: string
  anchor?: CaseAnchor
  at: number
  deliveredAt?: number
}

export interface CaseConclusion {
  rootCause: string
  anchors?: CaseAnchor[]
  fix?: string
  verified?: string
  at: number
}

export interface CaseRunning {
  command: string
  watches: CaseAnchor[]
  hypothesisId?: string
  startedAt: number
}

/** One line of the case's story, in the order it happened. */
export type CaseEntry =
  | { kind: 'hypothesis'; at: number; hypothesisId: string }
  | { kind: 'verdict'; at: number; hypothesisId: string; status: HypothesisStatus; text?: string }
  | { kind: 'run'; at: number; runId: string }
  | { kind: 'note'; at: number; text: string; anchors?: CaseAnchor[] }
  | { kind: 'message'; at: number; messageId: string }
  | { kind: 'conclusion'; at: number }

export interface CaseFile {
  id: string
  name: string
  symptom?: string
  origin: string
  startedAt: number
  /** live: recording now · closed: the agent stopped it · replay: a saved case playing back */
  status: 'live' | 'closed' | 'replay'
  hypotheses: CaseHypothesis[]
  runs: CaseRun[]
  messages: CaseMessage[]
  conclusion?: CaseConclusion
  running: CaseRunning | null
  entries: CaseEntry[]
  /** The capture to replay once the case is closed. */
  savedId?: string
  closedAt?: number
}

export function emptyCase(id: string, name: string, status: CaseFile['status'], origin = 'agent', startedAt = Date.now()): CaseFile {
  return {
    id,
    name,
    origin,
    startedAt,
    status,
    hypotheses: [],
    runs: [],
    messages: [],
    running: null,
    entries: [],
  }
}

function upsertHypothesis(list: CaseHypothesis[], h: CaseHypothesis): CaseHypothesis[] {
  const i = list.findIndex(x => x.id === h.id)
  if (i < 0) return [...list, h]
  const next = list.slice()
  next[i] = { ...list[i], ...h }
  return next
}

function toRun(raw: any, at: number): CaseRun {
  return {
    id: String(raw.id ?? `run-${at}`),
    n: Number(raw.n ?? 0),
    command: String(raw.command ?? ''),
    exitCode: Number(raw.exitCode ?? 0),
    timedOut: Boolean(raw.timedOut),
    durationMs: Number(raw.durationMs ?? 0),
    hypothesisId: raw.hypothesisId || undefined,
    headline: String(raw.headline ?? raw.error ?? ''),
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    watched: Array.isArray(raw.watched) ? raw.watched : [],
    calls: Array.isArray(raw.calls) ? raw.calls : [],
    functionsRun: raw.functionsRun,
    filesRun: raw.filesRun,
    outputTail: raw.outputTail,
    error: raw.error,
  }
}

/**
 * Fold one event into the case. Returns the same object when the event does
 * not concern the case, so callers can skip a store update.
 */
export function reduceCase(state: CaseFile | null, type: string, payload: any, at: number): CaseFile | null {
  switch (type) {
    case 'investigation:started':
      return emptyCase(String(payload?.id ?? ''), String(payload?.name ?? 'Investigation'), 'live', payload?.origin ?? 'agent', at)
    case 'investigation:stopped':
      if (!state || state.status === 'replay') return state
      return { ...state, status: 'closed', running: null, savedId: payload?.id ?? state.id, closedAt: at }
  }
  if (!state) return state
  switch (type) {
    case 'investigation:hypothesis': {
      const h = payload?.hypothesis as CaseHypothesis | undefined
      if (!h?.id) return state
      return {
        ...state,
        hypotheses: upsertHypothesis(state.hypotheses, h),
        entries: [...state.entries, { kind: 'hypothesis', at, hypothesisId: h.id }],
      }
    }
    case 'investigation:verdict': {
      const h = payload?.hypothesis as CaseHypothesis | undefined
      if (!h?.id) return state
      return {
        ...state,
        hypotheses: upsertHypothesis(state.hypotheses, h),
        entries: [...state.entries, { kind: 'verdict', at, hypothesisId: h.id, status: h.status, text: h.verdict }],
      }
    }
    case 'investigation:run_started':
      return {
        ...state,
        running: {
          command: String(payload?.command ?? ''),
          watches: Array.isArray(payload?.watches) ? payload.watches : [],
          hypothesisId: payload?.hypothesisId || undefined,
          startedAt: at,
        },
      }
    case 'investigation:run': {
      const run = toRun(payload?.run ?? {}, at)
      if (!run.n) run.n = state.runs.length + 1
      return {
        ...state,
        running: null,
        runs: [...state.runs.filter(r => r.id !== run.id), run],
        entries: [...state.entries, { kind: 'run', at, runId: run.id }],
      }
    }
    case 'investigation:note':
      if (!payload?.text) return state
      return {
        ...state,
        entries: [...state.entries, { kind: 'note', at, text: String(payload.text), anchors: payload.anchors }],
      }
    case 'investigation:conclusion':
      if (!payload?.conclusion) return state
      return {
        ...state,
        conclusion: payload.conclusion,
        entries: [...state.entries.filter(e => e.kind !== 'conclusion'), { kind: 'conclusion', at }],
      }
    case 'investigation:message': {
      const m = payload?.message as CaseMessage | undefined
      if (!m?.id) return state
      if (state.messages.some(x => x.id === m.id)) return state
      return {
        ...state,
        messages: [...state.messages, m],
        entries: [...state.entries, { kind: 'message', at, messageId: m.id }],
      }
    }
    case 'investigation:message_delivered': {
      const ids = new Set<string>(Array.isArray(payload?.ids) ? payload.ids : [])
      if (ids.size === 0) return state
      return {
        ...state,
        messages: state.messages.map(m => (ids.has(m.id) && !m.deliveredAt ? { ...m, deliveredAt: at } : m)),
      }
    }
    default:
      return state
  }
}

/** Build a case from archd's case state, for a window that opens mid-investigation. */
export function caseFromState(c: any): CaseFile | null {
  if (!c?.id) return null
  const base = emptyCase(c.id, c.name ?? 'Investigation', 'live', c.origin ?? 'agent', c.startedAt ?? Date.now())
  base.symptom = c.symptom || undefined
  base.hypotheses = c.hypotheses ?? []
  base.runs = (c.runs ?? []).map((r: any) => toRun(r, r.at ?? 0))
  base.messages = c.messages ?? []
  base.conclusion = c.conclusion ?? undefined
  const entries: CaseEntry[] = []
  for (const h of base.hypotheses) {
    entries.push({ kind: 'hypothesis', at: h.createdAt, hypothesisId: h.id })
    if (h.status !== 'open' && h.decidedAt) {
      entries.push({ kind: 'verdict', at: h.decidedAt, hypothesisId: h.id, status: h.status, text: h.verdict })
    }
  }
  for (const r of c.runs ?? []) entries.push({ kind: 'run', at: r.at ?? 0, runId: String(r.id) })
  for (const n of c.notes ?? []) entries.push({ kind: 'note', at: n.at, text: n.text, anchors: n.anchors })
  for (const m of base.messages) entries.push({ kind: 'message', at: m.at, messageId: m.id })
  if (base.conclusion) entries.push({ kind: 'conclusion', at: base.conclusion.at })
  entries.sort((a, b) => a.at - b.at)
  base.entries = entries
  return base
}

/** Steps for the canvas's trace animation: the calls that crossed files. */
export function traceStepsForRun(run: CaseRun, limit = 24) {
  return run.calls.slice(0, limit).map(c => ({
    callerFile: c.fromFileId,
    callerSymbol: c.fromSymbol,
    calleeFile: c.toFileId,
    calleeSymbol: c.toSymbol,
    callCount: c.calls,
  }))
}

/** One line a person can read: what the case has established so far. */
export function caseSummary(c: CaseFile): string {
  if (c.conclusion) return c.conclusion.rootCause
  const confirmed = c.hypotheses.filter(h => h.status === 'confirmed').at(-1)
  if (confirmed) return `Confirmed: ${confirmed.text}`
  const lastRun = c.runs.at(-1)
  if (lastRun?.findings[0]) return lastRun.findings[0].text.replace(/`/g, '')
  const open = c.hypotheses.filter(h => h.status === 'open').at(-1)
  if (open) return `Testing: ${open.text}`
  return c.symptom ?? 'Investigating'
}

export const CASE_EVENT_TYPES = [
  'investigation:hypothesis',
  'investigation:verdict',
  'investigation:run_started',
  'investigation:run',
  'investigation:conclusion',
  'investigation:message',
  'investigation:message_delivered',
] as const
