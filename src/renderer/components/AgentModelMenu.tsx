import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../../shared/agentDelivery'
import { InboxIcon } from './InboxIcon'

/**
 * Which model an agent runs with, chosen where the message is written.
 *
 * An agent Ambio runs offers the models it publishes (electron/agentModels.ts)
 * plus its own default; Ambio chat offers its service's models. The choice is
 * remembered per agent. Agents in other apps pick their model in their app,
 * so nothing is offered for them.
 */

const remembered = (key: string): string | null => { try { return localStorage.getItem(`ambio:model:${key}`) } catch { return null } }
const remember = (key: string, model: string) => { try { localStorage.setItem(`ambio:model:${key}`, model) } catch { /* kept for this session */ } }

const lists = new Map<string, Promise<ModelOption[]>>()
function hostModels(hostId: string): Promise<ModelOption[]> {
  let list = lists.get(hostId)
  if (!list) {
    list = window.ambio?.agentModels ? window.ambio.agentModels(hostId).catch(() => []) : Promise.resolve([])
    lists.set(hostId, list)
    void list.then(found => { if (!found.length) lists.delete(hostId) })
  }
  return list
}

export interface AgentModelChoice {
  options: ModelOption[]
  /** '' is the agent's own default, for an agent Ambio runs. */
  value: string
  /** True when the agent has a default of its own to fall back on. */
  hasDefault: boolean
  set: (model: string) => void
}

export function useAgentModel({ key, hostId, chatOptions, current }: {
  /** What the choice is remembered under: a host ID, or chat:<service>. */
  key: string
  /** An agent Ambio runs, whose models are looked up. */
  hostId?: string
  /** Ambio chat's models, its service's default first. */
  chatOptions?: ModelOption[]
  /** The model an open conversation last used. */
  current?: string
}): AgentModelChoice {
  const [found, setFound] = useState<ModelOption[]>([])
  const [, setVersion] = useState(0)
  useEffect(() => {
    setFound([])
    if (!hostId) return
    let active = true
    void hostModels(hostId).then(list => { if (active) setFound(list) })
    return () => { active = false }
  }, [hostId])
  const options = chatOptions ?? found
  const saved = key ? remembered(key) : null
  const value = chatOptions
    ? [current, saved].find(model => model && options.some(option => option.id === model)) ?? options[0]?.id ?? ''
    : saved && options.some(option => option.id === saved) ? saved : ''
  return {
    options, value, hasDefault: !chatOptions,
    set: model => { if (key) { remember(key, model); setVersion(version => version + 1) } },
  }
}

/** The model button beside the request type, opening the agent's models. */
export function AgentModelMenu({ model, disabled }: { model: AgentModelChoice; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  if (!model.options.length) return null
  const label = model.options.find(option => option.id === model.value)?.label ?? 'Default model'
  const choices = [...(model.hasDefault ? [{ id: '', label: 'Default model' }] : []), ...model.options]
  return <div ref={anchor} className="ambio-inbox__mode ambio-inbox__model" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-inbox__mode-button" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={`Model: ${label}`} title="Which model the agent uses" onClick={() => setOpen(!open)}>
      <span className="ambio-inbox__model-label">{label}</span><InboxIcon name="chevron" size={11} />
    </button>
    {open && <div className="ambio-inbox__mode-menu ambio-inbox__model-menu" role="menu" aria-label="Model">
      {choices.map(option => <button key={option.id || 'default'} type="button" role="menuitemradio" aria-checked={model.value === option.id} aria-label={option.label}
        autoFocus={model.value === option.id} onClick={() => { model.set(option.id); setOpen(false) }}>
        <strong>{option.label}</strong>{option.id && option.id !== option.label && <small>{option.id}</small>}{!option.id && <small>Whatever the agent is set to use</small>}
        {model.value === option.id && <InboxIcon name="check" size={13} />}
      </button>)}
    </div>}
  </div>
}

/** The same choice as a plain select, for setup. */
export function AgentModelSelect({ model, disabled }: { model: AgentModelChoice; disabled?: boolean }) {
  if (!model.options.length) return null
  return <select className="ambio-choose__model" aria-label="Model" value={model.value} disabled={disabled} onChange={event => model.set(event.target.value)}>
    {model.hasDefault && <option value="">Default model</option>}
    {model.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select>
}
