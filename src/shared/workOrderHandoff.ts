import { AGENT_RESPONSE_GUIDANCE } from './agentWorkflow.ts'
/**
 * The sentence that turns one pasted handoff into an attached chat: the chat
 * answers this request, then waits for the next ones itself.
 */
export const STAY_ATTACHED = 'After you reply, stay attached to Ambio: call get_inbox with watch: true, handle each request that arrives the same way, and keep doing that until I tell you to stop.'

export function workOrderHandoff(projectName: string, workspaceId: string, projectRoot: string, messageId: string, options: { stayAttached?: boolean } = {}): string {
  const handoff = `${AGENT_RESPONSE_GUIDANCE}\n\nCheck Ambio work order ${messageId} for project "${projectName}" (${projectRoot}). Call get_inbox with messageId "${messageId}" and expectedWorkspaceId "${workspaceId}". If your MCP connection is bound to another project, stop and tell me; do not work in the wrong project. If the claim fails or returns no work order, stop without editing files. If Ambio's tools are not available to you, stop and say so: never read or write Ambio's data (~/.ambio) or call Ambio's local service directly. Read the instruction, all attached context pages, and any review feedback. Renew the same claim before its 15-minute lease expires; after interruption, check ownership before continuing. For substantial work, call start_work with a one-sentence goal and the returned messageHandle, and use its sessionId for update_work, so progress stays on this request. Do only the requested work, then submit through reply_to_canvas with a clear summary and a result listing changed files, checks, commit, and remaining gaps when applicable. Do not claim another work order unless I ask.`
  return options.stayAttached ? `${handoff} ${STAY_ATTACHED}` : handoff
}
