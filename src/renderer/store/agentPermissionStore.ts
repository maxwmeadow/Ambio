import { create } from 'zustand'
import { archdApi } from '../archdEndpoint.ts'
import { raiseInvitation, resolveInterruption } from './interruptionStore.ts'

/**
 * Questions from agents Ambio started: "may I run this?".
 *
 * Nobody is at a started agent's keyboard, so what its turn did not already
 * allow is asked here and answered in the conversation. The daemon holds the
 * agent's request open until the answer arrives; no answer is a refusal. This
 * store is only the renderer's list of what is waiting.
 */

export interface AgentPermissionRequest {
  id: string
  workspaceId: string
  /** The turn the agent is working on, when it said. */
  messageId?: string
  hostId: string
  title: string
  detail?: string
  kind?: string
  askedAt: number
  expiresAt: number
}

interface PermissionState {
  requests: AgentPermissionRequest[]
}

export const useAgentPermissionStore = create<PermissionState>(() => ({ requests: [] }))

const interruption = (id: string) => `agent-permission-${id}`

/** Answer a question. A request that is no longer waiting is simply dropped. */
export async function decideAgentPermission(request: AgentPermissionRequest, decision: 'allow' | 'deny'): Promise<void> {
  drop(request.id)
  try {
    await fetch(`${archdApi()}/api/agent/permission/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: request.workspaceId, id: request.id, decision }),
    })
  } catch { /* the agent's wait ends by itself, as a refusal */ }
}

function drop(id: string): void {
  resolveInterruption(interruption(id))
  useAgentPermissionStore.setState(state => ({ requests: state.requests.filter(request => request.id !== id) }))
}

function add(request: AgentPermissionRequest): void {
  if (request.expiresAt <= Date.now()) return
  useAgentPermissionStore.setState(state => state.requests.some(item => item.id === request.id)
    ? state
    : { requests: [...state.requests, request].sort((a, b) => a.askedAt - b.askedAt) })
  // The agent is stopped until this is answered, so it is worth interrupting for.
  raiseInvitation(
    interruption(request.id),
    `An agent is asking: ${request.title}`,
    request.detail,
    [
      { label: 'Allow', primary: true, run: () => { void decideAgentPermission(request, 'allow') } },
      { label: 'Don’t allow', run: () => { void decideAgentPermission(request, 'deny') } },
    ],
  )
  // A question nobody answered stops being one.
  setTimeout(() => {
    if (useAgentPermissionStore.getState().requests.some(item => item.id === request.id)) drop(request.id)
  }, Math.max(0, request.expiresAt - Date.now()) + 500)
}

/** What is waiting in a project right now; called when a project opens. */
export async function refreshAgentPermissions(workspaceId: string): Promise<void> {
  if (!workspaceId) return
  try {
    const response = await fetch(`${archdApi()}/api/agent/permission?workspace=${encodeURIComponent(workspaceId)}`)
    if (!response.ok) return
    const { requests } = await response.json() as { requests: AgentPermissionRequest[] }
    for (const stale of useAgentPermissionStore.getState().requests) {
      if (stale.workspaceId !== workspaceId || !requests.some(item => item.id === stale.id)) drop(stale.id)
    }
    requests.forEach(add)
  } catch { /* the live events still arrive */ }
}

/** Live updates from the daemon, routed here by the sheet patch pipeline. */
export function handlePermissionPatch(patch: { type: string; payload: unknown }, workspaceId: string | null): boolean {
  if (patch.type === 'agent:permission') {
    const request = patch.payload as AgentPermissionRequest
    if (request.workspaceId === workspaceId) add(request)
    return true
  }
  if (patch.type === 'agent:permission-resolved') {
    drop((patch.payload as { id: string }).id)
    return true
  }
  return false
}
