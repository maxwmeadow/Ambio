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
  /** The agent's models are still being looked up. */
  loading: boolean
  set: (model: string) => void
  thinking?: string
  thinkingLevels?: Array<{ id: string; label: string }>
  setThinking?: (level: string) => void
}

export function useAgentModel({ key, hostId, chatOptions, current, context = '', currentThinking }: {
  /** What the choice is remembered under: a host ID, or chat:<service>. */
  key: string
  /** An agent Ambio runs, whose models are looked up. */
  hostId?: string
  /** Ambio chat's models, its service's default first. */
  chatOptions?: ModelOption[]
  /** The model an open conversation last used. */
  current?: string
  context?: string
  currentThinking?: string
}): AgentModelChoice {
  const [found, setFound] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const [, setVersion] = useState(0)
  const [choice, setChoice] = useState<{ context: string; value: string }>()
  const [thought, setThought] = useState<{ context: string; value: string }>()
  const identity = `${key}:${context}`
  useEffect(() => {
    setFound([])
    setLoading(!!hostId)
    if (!hostId) return
    let active = true
    void hostModels(hostId).then(list => { if (active) { setFound(list); setLoading(false) } })
    return () => { active = false }
  }, [hostId])
  const options = chatOptions ?? found
  const saved = key ? remembered(key) : null
  const normalize = (id: string | null | undefined) => options.find(option => option.id === id || option.aliases?.includes(id ?? ''))?.id
  const value = choice?.context === identity ? choice.value : chatOptions
    ? [current, saved].find(model => model && options.some(option => option.id === model)) ?? options[0]?.id ?? ''
    : normalize(current) ?? normalize(saved) ?? ''
  const selected = options.find(option => option.id === value)
  const thoughtIdentity = `${identity}:${value}`
  const aliasThinking = selected?.thinkingLevels?.find(level => [current, saved].includes(`${selected.id}-${level.id}`))?.id
  const thinking = thought?.context === thoughtIdentity ? thought.value : currentThinking ?? remembered(`${key}:thinking:${value}`) ?? aliasThinking ?? selected?.defaultThinking
  return {
    options, value, hasDefault: !chatOptions, loading: !chatOptions && loading,
    set: model => { if (key) { remember(key, model); setChoice({ context: identity, value: model }); setVersion(version => version + 1) } },
    thinking: selected?.thinkingLevels?.some(level => level.id === thinking) ? thinking : selected?.defaultThinking,
    thinkingLevels: selected?.thinkingLevels,
    setThinking: level => { remember(`${key}:thinking:${value}`, level); setThought({ context: thoughtIdentity, value: level }) },
  }
}

/**
 * The model button beside the request type, opening the agent's models. A model
 * with thinking levels shows its level on the button and as a row at the foot of
 * the menu, so the choice takes no room of its own in the composer.
 */
export function AgentModelMenu({ model, disabled }: { model: AgentModelChoice; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  if (model.loading) return <div className="ambio-inbox__mode ambio-inbox__model">
    <button type="button" className="ambio-inbox__mode-button ambio-inbox__model-loading" disabled aria-label="Model: loading" title="Looking up this agent's models">
      <span className="ambio-inbox__model-label">Loading models…</span>
    </button>
  </div>
  // An agent with no model choice here still shows the segment, so the pill keeps its shape.
  if (!model.options.length) return <div className="ambio-inbox__mode ambio-inbox__model">
    <button type="button" className="ambio-inbox__mode-button ambio-inbox__model-none" disabled aria-label="Model: the agent's own" title="This agent uses its own model setting">
      <span className="ambio-inbox__model-label">Default</span>
    </button>
  </div>
  const label = model.options.find(option => option.id === model.value)?.label ?? 'Default'
  const choices: ModelOption[] = [...(model.hasDefault ? [{ id: '', label: 'Default' }] : []), ...model.options]
  const levels = model.thinkingLevels ?? []
  const thinking = levels.find(level => level.id === model.thinking)?.label
  return <div ref={anchor} className="ambio-inbox__mode ambio-inbox__model" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-inbox__mode-button" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={`Model: ${label}${thinking ? `, ${thinking} thinking` : ''}`} title={thinking ? `${label} · ${thinking} thinking` : 'Which model the agent uses'} onClick={() => setOpen(!open)}>
      <span className="ambio-inbox__model-label">{label}</span>{thinking && <span className="ambio-inbox__model-thinking">{thinking}</span>}<InboxIcon name="chevron" size={11} />
    </button>
    {open && <div className="ambio-inbox__mode-menu ambio-inbox__model-menu" role="menu" aria-label="Model">
      {choices.map(option => <button key={option.id || 'default'} type="button" role="menuitemradio" aria-checked={model.value === option.id} aria-label={option.label}
        autoFocus={model.value === option.id} onClick={() => { model.set(option.id); if (!option.thinkingLevels?.length) setOpen(false) }}>
        <strong>{option.label}</strong>{option.id && option.id.toLowerCase() !== option.label.toLowerCase() && <small>{option.id}</small>}{!option.id && <small>Whatever the agent is set to use</small>}
        {model.value === option.id && <InboxIcon name="check" size={13} />}
      </button>)}
      {levels.length > 0 && <div className="ambio-inbox__model-levels" role="group" aria-label="Thinking">
        <span>Thinking</span>
        {levels.map(level => <button key={level.id} type="button" role="menuitemradio" aria-checked={model.thinking === level.id} aria-label={`Thinking: ${level.label}`}
          onClick={() => { model.setThinking?.(level.id); setOpen(false) }}>{level.label}</button>)}
      </div>}
    </div>}
  </div>
}

/** The same choice as a plain select, for setup. */
export function AgentModelSelect({ model, disabled }: { model: AgentModelChoice; disabled?: boolean }) {
  if (model.loading) return <select className="ambio-choose__model" aria-label="Model" disabled><option>Loading models…</option></select>
  if (!model.options.length) return null
  return <select className="ambio-choose__model" aria-label="Model" value={model.value} disabled={disabled} onChange={event => model.set(event.target.value)}>
    {model.hasDefault && <option value="">Default</option>}
    {model.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select>
}
