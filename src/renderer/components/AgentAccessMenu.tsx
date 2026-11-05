import { useEffect, useRef, useState } from 'react'
import { AGENT_ACCESS, DEFAULT_AGENT_ACCESS, isAgentAccess, type AgentAccess, type DeliveryHost } from '../../shared/agentDelivery'
import { InboxIcon } from './InboxIcon'

/**
 * How much an agent Ambio runs may do without asking, chosen beside its
 * model. Only an agent that honours the levels (DeliveryHost.access) offers
 * the choice; it is remembered per agent. What the agent asks appears as a
 * permission card in the conversation.
 */

const remembered = (hostId: string): string | null => { try { return localStorage.getItem(`ambio:access:${hostId}`) } catch { return null } }
const remember = (hostId: string, access: AgentAccess) => { try { localStorage.setItem(`ambio:access:${hostId}`, access) } catch { /* kept for this session */ } }

export interface AgentAccessChoice {
  /** The levels this agent offers; empty when it has no choice here. */
  levels: AgentAccess[]
  value?: AgentAccess
  set: (access: AgentAccess) => void
}

/** `only` narrows the levels for this conversation (an exec Codex conversation offers none). */
export function useAgentAccess(host?: DeliveryHost, only?: AgentAccess[]): AgentAccessChoice {
  const [, setVersion] = useState(0)
  const levels = (host?.access ?? []).filter(level => !only || only.includes(level))
  const saved = host ? remembered(host.id) : null
  const value = !levels.length ? undefined
    : isAgentAccess(saved) && levels.includes(saved) ? saved
      : levels.includes(DEFAULT_AGENT_ACCESS) ? DEFAULT_AGENT_ACCESS : levels[0]
  return { levels, value, set: access => { if (host) { remember(host.id, access); setVersion(version => version + 1) } } }
}

/** The access button beside the model, opening the levels the agent offers. */
export function AgentAccessMenu({ access, disabled }: { access: AgentAccessChoice; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  if (!access.levels.length || !access.value) return null
  const current = AGENT_ACCESS.find(level => level.id === access.value)!
  return <div ref={anchor} className="ambio-inbox__mode ambio-inbox__model ambio-inbox__access" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-inbox__mode-button" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={`Access: ${current.label}`} title={current.hint} onClick={() => setOpen(!open)}>
      <span className="ambio-inbox__model-label">{current.label}</span><InboxIcon name="chevron" size={11} />
    </button>
    {open && <div className="ambio-inbox__mode-menu ambio-inbox__model-menu" role="menu" aria-label="What the agent may do without asking">
      {AGENT_ACCESS.filter(level => access.levels.includes(level.id)).map(level => <button key={level.id} type="button" role="menuitemradio" aria-checked={access.value === level.id} aria-label={level.label}
        autoFocus={access.value === level.id} onClick={() => { access.set(level.id); setOpen(false) }}>
        <strong>{level.label}</strong><small>{level.hint}</small>
        {access.value === level.id && <InboxIcon name="check" size={13} />}
      </button>)}
    </div>}
  </div>
}
