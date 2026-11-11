import { useState } from 'react'
import type { AgentAction } from '../../shared/types'
import type { DeliveryHost } from '../../shared/agentDelivery'
import { AgentTurnCard } from './AgentTurn'
import { Chevron } from './ui/Chevron'
import { actionWorkItem, type OutsideActivity } from './outsideAgentActivity'
import { elapsed } from './AgentTurn'

/** An outside agent counts as still working this long after its last call. */
const STILL_WORKING_MS = 2 * 60_000

const agentLabel = (hosts: readonly DeliveryHost[], agent: string) =>
  hosts.find(host => host.id === agent)?.label ?? (agent && agent !== 'unknown' ? agent : 'An agent')

/**
 * A turn an agent outside Ambio picked up (from a handoff, or a session
 * watching Ambio): its Ambio calls are its steps, in the same card as a turn
 * Ambio ran.
 */
export function OutsideAgentTurn({ agent, actions, working, answer, hosts }: {
  agent: string
  actions: readonly AgentAction[]
  working: boolean
  answer?: { text: string; onCopy?: () => void; copied?: boolean }
  hosts: readonly DeliveryHost[]
}) {
  return <AgentTurnCard agent={agentLabel(hosts, agent)} working={working} startedAt={actions[0]?.ts} lastAt={actions.at(-1)?.ts}
    items={actions.map(actionWorkItem)} answer={answer} />
}

/**
 * Work agents outside Ambio did with it but in no conversation (Claude Code
 * in VS Code, Cursor, a terminal session): one quiet line each, at the top of
 * the panel, opening to its steps.
 */
export function OutsideAgents({ groups, hosts, goals, now }: {
  groups: readonly OutsideActivity[]
  hosts: readonly DeliveryHost[]
  /** What a work session said it was for, by session id. */
  goals: ReadonlyMap<string, string>
  now: number
}) {
  const [open, setOpen] = useState<string | null>(null)
  if (!groups.length) return null
  return <section className="ambio-outside" aria-label="Agents working outside Ambio">
    {groups.map(group => {
      const label = agentLabel(hosts, group.agent)
      const working = now - group.lastAt < STILL_WORKING_MS
      const steps = `${group.actions.length} ${group.actions.length === 1 ? 'step' : 'steps'}`
      const goal = group.sessionId ? goals.get(group.sessionId) : undefined
      const expanded = open === group.key
      return <div key={group.key} className="ambio-outside__item" data-working={working || undefined}>
        <button type="button" className="ambio-outside__line" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : group.key)}>
          <Chevron size={11} expanded={expanded} />
          <span><strong>{label}</strong> {working ? 'is working' : 'worked'} outside Ambio{goal ? `: ${goal}` : ''}</span>
          <small>{working ? steps : `${steps}, ${elapsed(now - group.lastAt)} ago`}</small>
        </button>
        {expanded && <AgentTurnCard className="ambio-outside__turn" agent={`${label}, outside Ambio`} working={working} startedAt={group.startedAt} lastAt={group.lastAt}
          items={group.actions.map(actionWorkItem)} status={goal} />}
      </div>
    })}
  </section>
}
