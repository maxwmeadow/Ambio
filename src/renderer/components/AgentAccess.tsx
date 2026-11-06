import { useId, useSyncExternalStore } from 'react'
import { AGENT_ACCESS, agentAccessDescriptions, isAgentAccess, recommendedAgentAccess, type AgentAccess, type DeliveryHost } from '../../shared/agentDelivery'
import '../styles/agentAccess.css'

/**
 * How much an agent Ambio runs may do without asking, remembered per agent.
 * Nothing is preselected: the agent's guide asks for a level the first time
 * the agent is chosen, and the level can be changed there again or in
 * Settings → Agents (DECISIONS 2026-11-05). What the agent asks appears as a
 * permission card in the conversation.
 */

const key = (hostId: string) => `ambio:access:${hostId}`
const CHANGED = 'ambio:access-changed'
// Kept for this window when storage is unavailable.
const unsaved = new Map<string, AgentAccess>()

export function rememberedAccess(hostId: string): AgentAccess | undefined {
  let saved: string | null = null
  try { saved = localStorage.getItem(key(hostId)) } catch { /* read from this window's copy */ }
  return isAgentAccess(saved) ? saved : unsaved.get(hostId)
}

export function rememberAccess(hostId: string, access: AgentAccess) {
  unsaved.set(hostId, access)
  try { localStorage.setItem(key(hostId), access) } catch { /* kept for this window */ }
  window.dispatchEvent(new Event(CHANGED))
}

// The composer, the guide and Settings read the same level, so a change in one shows in the others.
function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange)
  window.addEventListener('storage', onChange)
  return () => { window.removeEventListener(CHANGED, onChange); window.removeEventListener('storage', onChange) }
}

export function useRememberedAccess(hostId?: string): AgentAccess | undefined {
  return useSyncExternalStore(subscribe, () => hostId ? rememberedAccess(hostId) : undefined)
}

export interface AgentAccessChoice {
  /** The levels this conversation offers; empty when it has no choice here. */
  levels: AgentAccess[]
  /** The remembered level, when this conversation can run at it. */
  value?: AgentAccess
  /** Offered levels but none usable is remembered: the agent's guide must ask before sending. */
  needsChoice: boolean
}

/** `only` narrows the levels for this conversation (an exec Codex conversation offers none). */
export function useAgentAccess(host?: DeliveryHost, only?: AgentAccess[]): AgentAccessChoice {
  const levels = (host?.access ?? []).filter(level => !only || only.includes(level))
  const saved = useRememberedAccess(host?.id)
  // A CLI update can remove a level (Codex's qualified Auto). The choice is
  // kept until replaced explicitly, and never widened in the meantime.
  const value = levels.length && saved && levels.includes(saved) ? saved : undefined
  return { levels, value, needsChoice: levels.length > 0 && !value }
}

/**
 * The levels an agent offers, as a choice that applies to it everywhere:
 * the recommended one marked, none checked until the person picks one.
 */
export function AgentAccessChoices({ host, compact }: { host: DeliveryHost; compact?: boolean }) {
  const name = useId()
  const levels = host.access ?? []
  const saved = useRememberedAccess(host.id)
  const recommended = recommendedAgentAccess(levels)
  const descriptions = agentAccessDescriptions(host.id)
  if (!levels.length) return null
  return <fieldset className={`ambio-access-choice${compact ? ' ambio-access-choice--compact' : ''}`} data-chosen={saved && levels.includes(saved) ? true : undefined}>
    <legend>What {host.label} may do without asking</legend>
    {saved && !levels.includes(saved) && <p className="ambio-access-choice__note" role="note">
      {AGENT_ACCESS.find(level => level.id === saved)?.label} is not available in this version of {host.label}. Choose another level.
    </p>}
    {AGENT_ACCESS.filter(level => levels.includes(level.id)).map(level => <label key={level.id} className="ambio-access-choice__option">
      <input type="radio" name={name} value={level.id} checked={saved === level.id} onChange={() => rememberAccess(host.id, level.id)} />
      <span>
        <strong>{level.label}{level.id === recommended && <em>Recommended</em>}</strong>
        <small>{descriptions?.[level.id] ?? level.hint}</small>
      </span>
    </label>)}
  </fieldset>
}
