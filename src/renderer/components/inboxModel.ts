export function canvasReference(type: string, id: string, label: string): string {
  return `axiom://${type}/${encodeURIComponent(id)}?label=${encodeURIComponent(label)}`
}
export function workOrderHandoff(projectName: string, workspaceId: string, projectRoot: string, messageId: string): string {
  return `Check Axiom work order ${messageId} for project "${projectName}" (${projectRoot}). Call get_inbox with messageId "${messageId}" and expectedWorkspaceId "${workspaceId}". If your MCP connection is bound to another project, stop and tell me; do not work in the wrong project. Read the instruction and attached context. For substantial work, call start_work with the returned messageHandle and use its sessionId for update_work, so progress stays on this request. Do only the requested work, and reply through Axiom. Do not claim another work order unless I ask.`
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
export function inboxStatus(message: { status: string; agent?: string; deliveredTo?: string | null; leaseExpiresAt?: number }, now = Date.now()): string {
  if (message.status === 'answered') return 'Answered'
  if (message.status === 'cancelled') return 'Cancelled'
  if (message.status === 'delivered' && (message.leaseExpiresAt ?? 0) > now) return `Picked up by ${message.agent || 'agent'}${message.deliveredTo ? ` · connector ${message.deliveredTo.slice(0, 8)}` : ''}`
  return message.leaseExpiresAt ? 'Available again · previous claim expired' : 'Waiting for an agent'
}
