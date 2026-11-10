import { useEffect, useState } from 'react'
import type { ModelOption } from '../../shared/agentDelivery'

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
  /** The model's own level; without one the agent keeps its setting until a level is chosen. */
  defaultThinking?: string
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
    defaultThinking: selected?.defaultThinking,
    setThinking: level => { remember(`${key}:thinking:${value}`, level); setThought({ context: thoughtIdentity, value: level }) },
  }
}

/** A model's ID is worth a line only when it says more than its name ("GPT-6.1 Terra" is `gpt-6.1-terra`). */
export const idSaysMore = (option: ModelOption) => {
  const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  return letters(option.id) !== letters(option.label)
}

/** The models offered, with the agent's own default first where it has one. */
export function modelChoices(model: AgentModelChoice): ModelOption[] {
  return [...(model.hasDefault ? [{ id: '', label: 'Default' }] : []), ...model.options]
}

/** The chosen model's name, or Default. */
export function modelLabel(model: AgentModelChoice): string {
  return model.options.find(option => option.id === model.value)?.label ?? 'Default'
}

/** The chosen model's thinking level as a plain select, for setup; nothing for a model without levels. */
export function AgentThinkingSelect({ model, disabled }: { model: AgentModelChoice; disabled?: boolean }) {
  const levels = thinkingChoices(model)
  if (model.loading || !levels.length) return null
  return <select className="ambio-choose__model ambio-choose__thinking" aria-label="Thinking level" title="How much the agent thinks" value={model.thinking ?? ''} disabled={disabled} onChange={event => model.setThinking?.(event.target.value)}>
    {levels.map(level => <option key={level.id || 'default'} value={level.id}>{level.label} thinking</option>)}
  </select>
}

/**
 * The levels offered for the chosen model, the same in the composer and in
 * setup. A model with no default of its own (Claude Code) starts with Default:
 * the agent's own setting, and nothing is sent.
 */
export function thinkingChoices(model: AgentModelChoice): Array<{ id: string; label: string }> {
  const levels = model.thinkingLevels ?? []
  return levels.length && !model.defaultThinking ? [{ id: '', label: 'Default' }, ...levels] : levels
}

/** What the composer says for the level: always one, while the model has levels. */
export function thinkingLabel(model: AgentModelChoice): string | undefined {
  return thinkingChoices(model).find(level => level.id === (model.thinking ?? ''))?.label
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
