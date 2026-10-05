import type { CanvasMessage } from './sheetStore'

/**
 * What an OS notification says when a work order moves on the agent's side
 * while Ambio is in the background: picked up, or answered. Everything the
 * person did themselves (sending, accepting, reopening) and repeats of an
 * update already seen say nothing. Pure, so the rules are tested.
 */
export interface WorkOrderNotice {
  title: string
  body: string
  /** One notification per work order: a newer one replaces it. */
  tag: string
}

const BODY_LIMIT = 160

function orderName(message: CanvasMessage): string {
  if (message.sentSheetName) return `“${message.sentSheetName}”`
  const firstLine = message.note.split('\n').find(line => line.trim())?.trim() ?? ''
  if (!firstLine) return 'your work order'
  return `“${firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine}”`
}

function agentName(message: CanvasMessage): string {
  return message.reply?.agent || message.agent || message.deliveredTo || 'An agent'
}

export function workOrderNotice(previous: CanvasMessage | undefined, next: CanvasMessage): WorkOrderNotice | null {
  const tag = `work-order:${next.id}`
  if (next.status === 'answered' && next.reply) {
    if (previous?.status === 'answered' && previous.reply?.createdAt === next.reply.createdAt) return null
    const firstLine = next.reply.body.split('\n').find(line => line.trim())?.trim() ?? ''
    return {
      title: `${agentName(next)} replied to ${orderName(next)}`,
      body: firstLine.length > BODY_LIMIT ? `${firstLine.slice(0, BODY_LIMIT - 1)}…` : (firstLine || 'Open Ambio to review it.'),
      tag,
    }
  }
  if (next.status === 'delivered' && previous?.status !== 'delivered') {
    return { title: `${agentName(next)} picked up ${orderName(next)}`, body: 'You will be told when it replies.', tag }
  }
  return null
}
