export function canvasReference(type: string, id: string, label: string): string {
  return `axiom://${type}/${encodeURIComponent(id)}?label=${encodeURIComponent(label)}`
}
export function workOrderHandoff(projectName: string, workspaceId: string, projectRoot: string, messageId: string): string {
  return `Check Axiom work order ${messageId} for project "${projectName}" (${projectRoot}). Call get_inbox with messageId "${messageId}" and expectedWorkspaceId "${workspaceId}". If your MCP connection is bound to another project, stop and tell me; do not work in the wrong project. Read the instruction, attached context, and any review feedback. For substantial work, call start_work with the returned messageHandle and use its sessionId for update_work, so progress stays on this request. Do only the requested work, then submit through reply_to_canvas with a clear summary and a result listing changed files, checks, commit, and remaining gaps when applicable. Do not claim another work order unless I ask.`
}
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
