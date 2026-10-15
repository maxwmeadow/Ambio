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
export function inboxStatus(message: { status: string; agent?: string; deliveredTo?: string | null; leaseExpiresAt?: number; review?: { decision: string } }, now = Date.now()): string {
  if (message.status === 'answered') return message.review?.decision === 'accepted' ? 'Accepted' : 'Ready for review'
  if (message.status === 'cancelled') return 'Cancelled'
  if (message.status === 'delivered' && (message.leaseExpiresAt ?? 0) > now) return `Picked up by ${message.agent || 'agent'}${message.deliveredTo ? ` · connector ${message.deliveredTo.slice(0, 8)}` : ''}`
  if (message.review?.decision === 'reopened') return 'Changes requested · waiting for agent'
  return message.leaseExpiresAt ? 'Available again · previous claim expired' : 'Waiting for an agent'
}

/**
 * Where a work order stands, for the inbox's stage filter: one bucket per
 * order, matching what inboxStatus says about it.
 */
export type WorkOrderStage = 'waiting' | 'working' | 'review' | 'accepted' | 'cancelled'

export const WORK_ORDER_STAGES: Array<{ stage: WorkOrderStage; label: string }> = [
  { stage: 'waiting', label: 'Waiting' },
  { stage: 'working', label: 'Working' },
  { stage: 'review', label: 'To review' },
  { stage: 'accepted', label: 'Accepted' },
  { stage: 'cancelled', label: 'Cancelled' },
]

export function workOrderStage(message: { status: string; leaseExpiresAt?: number; review?: { decision: string } }, now = Date.now()): WorkOrderStage {
  if (message.status === 'answered') return message.review?.decision === 'accepted' ? 'accepted' : 'review'
  if (message.status === 'cancelled') return 'cancelled'
  if (message.status === 'delivered' && (message.leaseExpiresAt ?? 0) > now) return 'working'
  return 'waiting'
}

export function workOrderStageCounts(messages: Array<Parameters<typeof workOrderStage>[0]>, now = Date.now()): Record<WorkOrderStage, number> {
  const counts: Record<WorkOrderStage, number> = { waiting: 0, working: 0, review: 0, accepted: 0, cancelled: 0 }
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
  propose: 'Propose, do not build: draw your plan on a sheet (edit_sheet create, plan_element), reply with what you drew, and wait for me to confirm before changing any code.',
  build: '',
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
export function turnRequest(message: { note: string; mode?: string }): { mode: WorkOrderMode; text: string } {
  for (const mode of ['ask', 'propose'] as const) {
    const prefix = `${MODE_CONTRACT[mode]}\n\n`
    if (message.note.startsWith(prefix)) return { mode, text: message.note.slice(prefix.length) }
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
  const counts: Record<WorkOrderStage, number> = { waiting: 0, working: 0, review: 0, accepted: 0, cancelled: 0 }
  for (const thread of threads) counts[thread.stage]++
  return counts
}
