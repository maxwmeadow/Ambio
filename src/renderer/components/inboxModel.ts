export function canvasReference(type: string, id: string, label: string): string {
  return `ambio://${type}/${encodeURIComponent(id)}?label=${encodeURIComponent(label)}`
}
export { workOrderHandoff } from '../../shared/workOrderHandoff.ts'
export function referenceTarget(reference: string): { id: string; label: string } {
  try {
    const url = new URL(reference)
    const id = decodeURIComponent(url.pathname.slice(1))
    return { id: url.host === 'planned' ? `planned:${id}` : id, label: url.searchParams.get('label') || id || reference }
  } catch { return { id: '', label: reference } }
}
export function messageReferences(selection: string): string[] {
  try { const refs = JSON.parse(selection); return Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string') : [] } catch { return [] }
}
/**
 * Only a build changes anything, so only a build's answer waits for review; an
 * answered question or proposal is done. A turn sent before turns carried a
 * mode is read from its contract.
 */
export function needsReview(message: { mode?: string; note?: string }): boolean {
  return (message.mode ?? (message.note !== undefined ? turnRequest({ note: message.note }).mode : 'build')) === 'build'
}

export function inboxStatus(message: { status: string; agent?: string; deliveredTo?: string | null; leaseExpiresAt?: number; review?: { decision: string }; mode?: string; note?: string }, now = Date.now()): string {
  if (message.status === 'answered') return !needsReview(message) ? 'Answered' : message.review?.decision === 'accepted' ? 'Accepted' : 'Ready for review'
  if (message.status === 'cancelled') return 'Cancelled'
  if (message.status === 'delivered' && (message.leaseExpiresAt ?? 0) > now) return `Picked up by ${message.agent || 'agent'}`
  if (message.review?.decision === 'reopened') return 'Changes requested · waiting for agent'
  return message.leaseExpiresAt ? 'Available again · previous claim expired' : 'Waiting for an agent'
}

/**
 * Where a work order stands, for the inbox's stage filter: one bucket per
 * order, matching what inboxStatus says about it.
 */
export type WorkOrderStage = 'waiting' | 'working' | 'review' | 'accepted' | 'answered' | 'cancelled'

export const WORK_ORDER_STAGES: Array<{ stage: WorkOrderStage; label: string }> = [
  { stage: 'waiting', label: 'Waiting' },
  { stage: 'working', label: 'Working' },
  { stage: 'review', label: 'To review' },
  { stage: 'accepted', label: 'Accepted' },
  { stage: 'answered', label: 'Answered' },
  { stage: 'cancelled', label: 'Cancelled' },
]

export function workOrderStage(message: { status: string; leaseExpiresAt?: number; review?: { decision: string }; mode?: string; note?: string }, now = Date.now()): WorkOrderStage {
  if (message.status === 'answered') return !needsReview(message) ? 'answered' : message.review?.decision === 'accepted' ? 'accepted' : 'review'
  if (message.status === 'cancelled') return 'cancelled'
  if (message.status === 'delivered' && (message.leaseExpiresAt ?? 0) > now) return 'working'
  return 'waiting'
}

export function workOrderStageCounts(messages: Array<Parameters<typeof workOrderStage>[0]>, now = Date.now()): Record<WorkOrderStage, number> {
  const counts: Record<WorkOrderStage, number> = { waiting: 0, working: 0, review: 0, accepted: 0, answered: 0, cancelled: 0 }
  for (const message of messages) counts[workOrderStage(message, now)]++
  return counts
}

/**
 * What kind of work order this is (WORK send-dialog-modes). Asking, asking
 * for a plan and ordering a build are different contracts; the contract is
 * written into the order itself, so every host and agent reads it the same
 * way. A build says nothing extra: it is what a work order already is.
 */
export type WorkOrderMode = 'ask' | 'propose' | 'build'

export const WORK_ORDER_MODES: Array<{ mode: WorkOrderMode; label: string; hint: string }> = [
  { mode: 'ask', label: 'Ask', hint: 'A question: the agent answers and changes nothing' },
  { mode: 'propose', label: 'Propose', hint: 'The agent draws a plan on a sheet and waits for you' },
  { mode: 'build', label: 'Build', hint: 'The agent does the work' },
]

const MODE_CONTRACT: Record<WorkOrderMode, string> = {
  ask: 'This is a question. Answer it in your reply; do not change code or the architecture map.',
  // An agent left to "draw your plan" redrew systems the map already had, as
  // empty top-level boxes. Start from the map, and draw only the change.
  propose: 'Propose, do not build. Start from the current map (get_architecture overview and system_files for the systems involved): if part of what I ask for already exists, say so and reuse it rather than redrawing it. On a sheet, draw only what changes: plan_element each new system inside its parent, with the existing files or systems it takes over in owns; edit_sheet(move) existing files or systems that change boundary; edit_sheet(rename) a system whose role changes; edit_sheet(connect) new dependencies. Reply with what already existed and what you drew, and wait for me to confirm before changing any code.',
  build: '',
}

/** Contracts earlier versions wrote into turns, still recognised when reading them back. */
const PAST_CONTRACTS: Partial<Record<WorkOrderMode, string[]>> = {
  propose: [
    'Propose, do not build. Start from the current map (get_architecture overview and system_files for the systems involved): if part of what I ask for already exists, say so and reuse it rather than redrawing it. On a sheet, draw only what changes: plan_element each new system inside its parent, with the existing files or systems it takes over in owns; edit_sheet(move) existing files or systems that change boundary; edit_sheet(connect) new dependencies. Reply with what already existed and what you drew, and wait for me to confirm before changing any code.',
    'Propose, do not build: draw your plan on a sheet (edit_sheet create, plan_element), reply with what you drew, and wait for me to confirm before changing any code.'],
}

export function workOrderNote(mode: WorkOrderMode, note: string): string {
  const contract = MODE_CONTRACT[mode]
  return contract ? `${contract}\n\n${note}` : note
}

/**
 * A turn as the person wrote it: the request without the contract that was
 * written into it for the agent, and what kind of turn it was. A turn from
 * before turns carried their mode is read from its contract.
 */
/**
 * What a mapping turn is, ahead of the brief. A Propose turn's usual contract
 * asks for a sheet; a mapping writes a proposed map with edit_systems, which
 * the user reviews, so it says that instead.
 */
export const MAPPING_CONTRACT = 'This is a mapping request. Do not change any code. Follow the brief below and propose the architecture with edit_systems; the human reviews the proposal before it becomes the map. Do not draw a sheet for this.'

/** How a mapping turn reads in the conversation, instead of its whole brief. */
export const MAPPING_TITLE = 'Map this project\u2019s architecture'

/** The person-facing text of a request: a mapping turn reads as its title. */
export function requestText(text: string): string {
  return text.startsWith(MAPPING_CONTRACT) ? MAPPING_TITLE : text
}

export function turnRequest(message: { note: string; mode?: string }): { mode: WorkOrderMode; text: string } {
  if (message.note.startsWith(MAPPING_CONTRACT)) return { mode: 'propose', text: MAPPING_TITLE }
  for (const mode of ['ask', 'propose'] as const) {
    for (const contract of [MODE_CONTRACT[mode], ...(PAST_CONTRACTS[mode] ?? [])]) {
      const prefix = `${contract}\n\n`
      if (message.note.startsWith(prefix)) return { mode, text: message.note.slice(prefix.length) }
    }
  }
  const mode = message.mode === 'ask' || message.mode === 'propose' ? message.mode : 'build'
  return { mode, text: message.note }
}

/**
 * A conversation: the requests that share a thread, oldest first. A request
 * with no thread of its own (sent before conversations) is a conversation of
 * one.
 */
export interface Conversation<T> {
  id: string
  /** The first request, as the person wrote it. */
  title: string
  turns: T[]
  lastAt: number
  /** Where the latest turn that was not cancelled stands. */
  stage: WorkOrderStage
}

type ConversationTurn = Parameters<typeof workOrderStage>[0] & { id: string; threadId?: string; note: string; mode?: string; createdAt: number }

export function conversations<T extends ConversationTurn>(messages: T[], now = Date.now()): Conversation<T>[] {
  const byThread = new Map<string, T[]>()
  for (const message of messages) {
    const id = message.threadId || message.id
    byThread.set(id, [...(byThread.get(id) ?? []), message])
  }
  return [...byThread].map(([id, unordered]) => {
    const turns = [...unordered].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    const latest = [...turns].reverse().find(turn => turn.status !== 'cancelled') ?? turns[turns.length - 1]
    return {
      id, turns,
      title: turnRequest(turns[0]).text.split('\n')[0].trim(),
      lastAt: turns[turns.length - 1].createdAt,
      stage: workOrderStage(latest, now),
    }
  }).sort((a, b) => b.lastAt - a.lastAt || (a.id < b.id ? 1 : -1))
}

/** How many conversations stand at each stage, for the overview in the conversation menu. */
export function conversationStageCounts(threads: Array<{ stage: WorkOrderStage }>): Record<WorkOrderStage, number> {
  const counts: Record<WorkOrderStage, number> = { waiting: 0, working: 0, review: 0, accepted: 0, answered: 0, cancelled: 0 }
  for (const thread of threads) counts[thread.stage]++
  return counts
}
