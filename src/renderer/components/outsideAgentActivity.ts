import type { AgentAction } from '../../shared/types'
import type { DeliveryEvent, DeliveryRun } from '../../shared/agentDelivery'
import type { WorkItem } from './AgentTurn'

/**
 * What agents did through Ambio's tools, as steps in the agent panel.
 *
 * Every Ambio tool call an agent makes is recorded (mcp/agentAction.ts). An
 * agent Ambio started already shows those calls in its own turn, from its
 * transcript, so only the rest is shown from the record: a turn an agent
 * outside Ambio picked up, and work an outside agent did with no conversation
 * at all (Claude Code in VS Code, Cursor, a terminal session using Ambio).
 */

/** When one of Ambio's own runs was at work, for one agent. */
export interface RunWindow { hostId: string; from: number; to: number }

/** A finished run is counted as at work this long after its last sign of life. */
const RUN_GRACE_MS = 60_000

export function ambioRunWindows(runs: readonly DeliveryRun[], events: Record<string, readonly DeliveryEvent[] | undefined>, now: number): RunWindow[] {
  return runs.map(run => {
    const working = run.state === 'starting' || run.state === 'running' || run.state === 'stopping'
    const last = (events[run.key] ?? []).reduce((latest, event) => Math.max(latest, event.at), run.startedAt)
    return { hostId: run.hostId, from: run.startedAt - 5_000, to: working ? now + RUN_GRACE_MS : last + RUN_GRACE_MS }
  })
}

/** Whether a recorded call came from one of Ambio's own runs (its turn already shows it). */
export function ranByAmbio(action: Pick<AgentAction, 'agent' | 'ts'>, windows: readonly RunWindow[]): boolean {
  return windows.some(window => window.hostId === action.agent && action.ts >= window.from && action.ts <= window.to)
}

function parseDetail(detail: string | undefined): { input?: string; output?: string } {
  if (!detail) return {}
  try {
    const value = JSON.parse(detail) as { input?: unknown; output?: unknown }
    return {
      ...(typeof value.input === 'string' ? { input: value.input } : {}),
      ...(typeof value.output === 'string' ? { output: value.output } : {}),
    }
  } catch { return {} }
}

/** One recorded call as a step: Ambio, the tool, what it was about; opening to what it was asked and answered. */
export function actionWorkItem(action: AgentAction): WorkItem {
  const { input, output } = parseDetail(action.detail)
  const failed = action.status === 'error'
  return {
    key: `action:${action.id}`,
    kind: 'tool',
    // Joined the way the agents' own step labels are; the row shows each part once.
    text: ['Ambio', action.tool, action.summary].filter(Boolean).join(' \u00b7 '),
    status: failed ? 'failed' : 'completed',
    ...(input ? { input } : {}),
    ...(failed ? { output: action.error || output || '' } : output ? { output } : {}),
    ...(action.targets.length ? { targets: action.targets } : {}),
  }
}

/** Calls that are not steps: the connection announcement says nothing about the work. */
const isStep = (action: AgentAction) => action.tool !== 'connect'

/** Work an outside agent did with no conversation: one agent, one stretch of activity. */
export interface OutsideActivity {
  key: string
  agent: string
  sessionId?: string
  actions: AgentAction[]
  startedAt: number
  lastAt: number
}

/** A pause this long starts a new stretch of an outside agent's work. */
const OUTSIDE_GAP_MS = 15 * 60_000

/**
 * Outside agents' work that belongs to no conversation, newest first. Calls
 * from Ambio's own runs and from work sessions a conversation's turn already
 * shows are left out.
 */
export function outsideActivity(actions: readonly AgentAction[], windows: readonly RunWindow[], shownSessions: ReadonlySet<string>): OutsideActivity[] {
  const loose = actions
    .filter(action => isStep(action) && !ranByAmbio(action, windows) && !(action.sessionId && shownSessions.has(action.sessionId)))
    .sort((a, b) => a.ts - b.ts || a.id - b.id)
  const open = new Map<string, OutsideActivity>()
  const groups: OutsideActivity[] = []
  for (const action of loose) {
    const who = `${action.agent || 'unknown'}\u0000${action.sessionId ?? ''}`
    const current = open.get(who)
    if (current && action.ts - current.lastAt <= OUTSIDE_GAP_MS) {
      current.actions.push(action)
      current.lastAt = action.ts
      continue
    }
    const group: OutsideActivity = {
      key: `${who}\u0000${action.id}`, agent: action.agent || 'unknown',
      ...(action.sessionId ? { sessionId: action.sessionId } : {}),
      actions: [action], startedAt: action.ts, lastAt: action.ts,
    }
    open.set(who, group)
    groups.push(group)
  }
  return groups.sort((a, b) => b.lastAt - a.lastAt)
}

/** The calls an outside agent made for a turn, from the work sessions it started for it. */
export function turnActions(actions: readonly AgentAction[], sessionIds: readonly string[]): AgentAction[] {
  if (!sessionIds.length) return []
  const ids = new Set(sessionIds)
  return actions.filter(action => isStep(action) && !!action.sessionId && ids.has(action.sessionId)).sort((a, b) => a.ts - b.ts || a.id - b.id)
}
