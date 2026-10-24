import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentHostInfo } from '../../../electron/preload'
import { CLI_CLIENTS, type DeliveryEvent, type DeliveryHost, type DeliveryRun } from '../../shared/agentDelivery'
import type { ChatProvider, ChatSnapshot } from '../../shared/agentChat'
import { useSheetStore } from '../store/sheetStore'
import { CHAT_PROVIDERS_CHANGED } from '../components/AgentChatPanel'
import { MAPPING_CONTRACT } from '../components/inboxModel'
import { useProposalDrafts } from '../components/ProposalDraftProgress'
import { discoveryRequest } from '../components/agentDiscovery'

/**
 * Mapping a project with an agent Ambio runs itself: Ambio chat, or a CLI on
 * this computer. Nothing to install or restart; the run is an ordinary
 * Propose turn, so it also appears as a conversation in the agent panel.
 * Agents in other apps keep the install → restart → command path.
 */

/** A mapping Ambio started, kept per project so reopening setup follows it. */
export type MappingRun =
  | { kind: 'run'; workspaceId: string; messageId: string; hostId: string; label: string; model?: string }
  | { kind: 'chat'; workspaceId: string; conversationId: string; label: string; model?: string }

const runKey = (workspaceId: string) => `ambio:setup-mapping:${workspaceId}`

export function rememberedMappingRun(workspaceId: string): MappingRun | null {
  try {
    const saved = JSON.parse(localStorage.getItem(runKey(workspaceId)) ?? 'null')
    return saved && saved.workspaceId === workspaceId && (saved.kind === 'run' || saved.kind === 'chat') ? saved : null
  } catch { return null }
}

export function rememberMappingRun(run: MappingRun | null, workspaceId: string): void {
  try { run ? localStorage.setItem(runKey(workspaceId), JSON.stringify(run)) : localStorage.removeItem(runKey(workspaceId)) } catch { /* followed in memory */ }
}

/** An agent Ambio can run to map a project, or Ambio chat before it is set up. */
export type RunnableChoice =
  | { id: string; label: string; kind: 'chat'; provider: ChatProvider }
  | { id: string; label: string; kind: 'run'; host: DeliveryHost }
  // Ambio chat before a model service exists: offered so it is never invisible.
  | { id: string; label: string; kind: 'setup' }

export const CHAT_SETUP = 'chat-setup'

/** What setup has chosen, for the mascot beside it. */
export type MappingChoice = { label: string; kind: 'chat' | 'run' | 'setup' | 'app'; available?: boolean } | null

/** Ambio chat's services and the CLIs on this computer, kept current as services change. */
export function useRunnableChoices() {
  const [targets, setTargets] = useState<DeliveryHost[]>(() => CLI_CLIENTS.map(client => ({ ...client, route: 'run', available: false, detail: 'CLI not found.' })))
  const [providers, setProviders] = useState<ChatProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const active = useRef(false)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true); setError('')
    const current = () => active.current && generation.current === request
    const failures: string[] = []
    await Promise.allSettled([
      discoveryRequest(() => window.ambio.listDeliveryHosts()).then(found => {
        if (current()) setTargets(CLI_CLIENTS.map(client => found.find(host => host.id === client.id && host.route === 'run') ?? { ...client, route: 'run', available: false, detail: 'CLI not found.' }))
      }).catch(() => {
        failures.push('Could not check CLI installations. Rescan to retry.')
        if (current()) setTargets(previous => previous.map(host => ({ ...host, available: false, discoveryError: 'Could not check this CLI. Rescan to retry.' })))
      }),
      discoveryRequest(() => window.ambio.chatProviders()).then(found => { if (current()) setProviders(found) }).catch(() => { failures.push('Could not load model services. Rescan to retry.') }),
    ])
    if (current()) { setLoading(false); setError(failures.join(' ')) }
  }, [])
  useEffect(() => {
    active.current = true
    void refresh()
    const load = () => { void refresh() }
    window.addEventListener(CHAT_PROVIDERS_CHANGED, load)
    return () => { active.current = false; ++generation.current; window.removeEventListener(CHAT_PROVIDERS_CHANGED, load) }
  }, [refresh])
  const choices: RunnableChoice[] = [
    ...targets.map(host => ({ id: host.id, label: CLI_CLIENTS.find(client => client.id === host.id)?.label ?? host.label, kind: 'run' as const, host })),
    ...providers.map(provider => ({ id: `chat:${provider.id}`, label: 'Ambio chat', kind: 'chat' as const, provider })),
    ...(providers.length ? [] : [{ id: CHAT_SETUP, label: 'Ambio chat', kind: 'setup' as const }]),
  ]
  return { choices, loading, error, refresh }
}

/**
 * Start mapping with an agent Ambio runs. Adding Ambio to the user's own
 * sessions of that CLI is attempted first when asked; it never blocks the run.
 * Returns the run, and a warning when the add did not work.
 */
export async function startMapping({ choice, workspaceId, projectRoot, installer, required, model }: {
  choice: Exclude<RunnableChoice, { kind: 'setup' }>; workspaceId: string; projectRoot: string; installer?: AgentHostInfo
  /** An install the agent cannot work without (RUN_NEEDS_INSTALL): a failure stops the mapping. */
  required?: AgentHostInfo; model?: string
}): Promise<{ run: MappingRun; warning?: string }> {
  if (choice.kind === 'run' && !choice.host.available) throw new Error(choice.host.discoveryError ?? 'This CLI is not available. Locate its executable or rescan before mapping.')
  let warning: string | undefined
  if (required) {
    const outcome = await window.ambio.installAgent(required.id, projectRoot).catch(failure => ({ ok: false, detail: String(failure) }))
    if (!outcome.ok) throw new Error(`Ambio could not be added to ${required.familyLabel || required.label}, so ${choice.label} would have no access to Ambio: ${outcome.detail}`)
  }
  if (installer) {
    const outcome = await window.ambio.installAgent(installer.id, projectRoot).catch(failure => ({ ok: false, detail: String(failure) }))
    if (!outcome.ok) warning = `Ambio could not be added to your own ${choice.label} sessions: ${outcome.detail} The mapping still runs.`
  }
  const brief = await window.ambio.mappingBrief()
  let run: MappingRun
  if (choice.kind === 'chat') {
    const conversation = await window.ambio.createChat(workspaceId, choice.provider.id, model)
    await window.ambio.sendChat({ conversationId: conversation.id, text: `${MAPPING_CONTRACT}\n\n${brief}`, mode: 'propose', ...(model ? { model } : {}) })
    run = { kind: 'chat', workspaceId, conversationId: conversation.id, label: choice.label, model }
  } else {
    const messageId = crypto.randomUUID()
    await useSheetStore.getState().sendToAgent(workspaceId, `${MAPPING_CONTRACT}\n\n${brief}`, [], null, messageId, [], { threadId: messageId, mode: 'propose' })
    await window.ambio.deliverWorkOrder({ workspaceId, messageId, hostId: choice.host.id, ...(model ? { model } : {}) })
    run = { kind: 'run', workspaceId, messageId, hostId: choice.host.id, label: choice.label, model }
  }
  rememberMappingRun(run, workspaceId)
  return { run, warning }
}

export type MappingState = 'working' | 'done' | 'failed' | 'stopped' | 'waiting'

/** Live summary shared with the parent stage and Field Agent 04. */
export interface MappingSummary {
  state: MappingState
  filesCount: number
  systemsCount: number
  latestAction: string
  error?: string
}

export interface ActivityEvent {
  id: string
  kind: 'tool' | 'text' | 'thinking' | 'error'
  text: string
  at: number
}

function parseToolInfo(text: string): { badge: string; toolName: string; target: string } {
  const parts = text.split(' · ')
  if (parts.length >= 2 && parts[0] === 'Ambio') {
    return {
      badge: 'Ambio',
      toolName: parts[1],
      target: parts.slice(2).join(' · '),
    }
  }
  if (parts.length >= 2) {
    const rawTool = parts[0]
    const target = parts.slice(1).join(' · ')
    const lower = rawTool.toLowerCase()
    let badge = 'Tool'
    if (lower.includes('view') || lower.includes('read') || lower.includes('file')) badge = 'Read'
    else if (lower.includes('dir') || lower.includes('list')) badge = 'List'
    else if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) badge = 'Search'
    else if (lower.includes('cmd') || lower.includes('command') || lower.includes('shell') || lower.includes('exec') || lower.includes('run')) badge = 'Run'
    else if (lower.includes('edit') || lower.includes('write')) badge = 'Edit'
    return { badge, toolName: rawTool, target }
  }
  const lower = text.toLowerCase()
  let badge = 'Tool'
  if (lower.includes('view') || lower.includes('read')) badge = 'Read'
  else if (lower.includes('dir') || lower.includes('list')) badge = 'List'
  else if (lower.includes('search') || lower.includes('find')) badge = 'Search'
  return { badge, toolName: text, target: '' }
}

function cleanErrorMessage(raw: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.error === 'string') return cleanErrorMessage(parsed.error)
  } catch { /* not JSON */ }
  const match = /\{"error":"(.*?)"\}/.exec(raw)
  if (match) return match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ')
  return raw.replace(/\\"/g, '"').replace(/\\n/g, ' ')
}

/** How much of a run's activity is kept on screen. */
const LOG_ITEMS = 600

/** What the mapping agent is doing, live, with formatted streams and recovery controls. */
export function MappingActivity({
  run,
  onDismiss,
  onState,
  onSummary,
  onRetry,
}: {
  run: MappingRun
  onDismiss: () => void
  onState?: (state: MappingState) => void
  onSummary?: (summary: MappingSummary) => void
  onRetry?: () => void
}) {
  const [items, setItems] = useState<ActivityEvent[]>([])
  const [state, setState] = useState<MappingState>('working')
  const [detail, setDetail] = useState('')
  const [current, setCurrent] = useState<DeliveryRun | null>(null)
  const [startTime, setStartTime] = useState<number>(() => Date.now())
  const [elapsed, setElapsed] = useState<number>(0)
  const after = useRef(0)
  const log = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useLayoutEffect(() => {
    const el = log.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [items])

  // Timer for elapsed seconds
  useEffect(() => {
    if (state !== 'working' && state !== 'waiting') return
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [state, startTime])

  const drafts = useProposalDrafts(run.workspaceId, 2000)

  useEffect(() => {
    let active = true
    let finished = false
    after.current = 0
    setItems([])
    setDetail('')
    setStartTime(Date.now())
    setElapsed(0)
    const poll = async () => {
      if (finished) return
      try {
        if (run.kind === 'chat') {
          const snapshot: ChatSnapshot = await window.ambio.chatSnapshot(run.conversationId)
          if (!active) return
          const parts = snapshot.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts)
          const converted: ActivityEvent[] = parts.map((part, index) => {
            if (part.kind === 'tool') {
              return {
                id: `chat-tool-${index}`,
                kind: 'tool' as const,
                text: `${part.tool ?? 'tool'}${part.state ? ` · ${part.state}` : ''}`,
                at: Date.now(),
              }
            }
            if (part.kind === 'reasoning') {
              return {
                id: `chat-think-${index}`,
                kind: 'thinking' as const,
                text: part.text.trim(),
                at: Date.now(),
              }
            }
            return {
              id: `chat-text-${index}`,
              kind: 'text' as const,
              text: part.text.trim(),
              at: Date.now(),
            }
          }).filter(item => Boolean(item.text))
          setItems(converted.slice(-LOG_ITEMS))
          const status = snapshot.conversation.state
          setState(status === 'working' ? 'working' : status === 'waiting' ? 'waiting' : status === 'interrupted' ? 'stopped' : status === 'failed' ? 'failed' : 'done')
          finished = !['working', 'waiting'].includes(status)
          setDetail(snapshot.conversation.error ?? (snapshot.questions.length ? 'The agent has a question. Open the canvas and answer it in the agent panel.' : ''))
        } else {
          const runs = await window.ambio.listDeliveryRuns(run.workspaceId)
          const latest = runs.filter(item => item.messageId === run.messageId).sort((a, b) => b.startedAt - a.startedAt)[0]
          if (!active || !latest) return
          setCurrent(latest)
          const events: DeliveryEvent[] = await window.ambio.listDeliveryEvents(run.workspaceId, latest.key, after.current)
          if (!active) return
          if (events.length) {
            after.current += events.length
            const newItems: ActivityEvent[] = events.map((event, index) => ({
              id: `run-${after.current - events.length + index}`,
              kind: event.kind as 'tool' | 'text' | 'thinking' | 'error',
              text: event.text.trim(),
              at: event.at,
            })).filter(item => Boolean(item.text))
            setItems(previous => [...previous, ...newItems].slice(-LOG_ITEMS))
          }
          setState(latest.state === 'running' || latest.state === 'starting' || latest.state === 'stopping' ? 'working'
            : latest.state === 'completed' ? 'done' : latest.state === 'stopped' ? 'stopped' : 'failed')
          setDetail(latest.state === 'completed' ? '' : latest.detail)
          finished = !['running', 'starting', 'stopping'].includes(latest.state)
        }
      } catch (failure) {
        if (active) setDetail(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 1500)
    return () => { active = false; clearInterval(timer) }
  }, [run])

  useEffect(() => { onState?.(state) }, [state, onState])

  const filesCount = useMemo(() => {
    const fileSet = new Set<string>()
    for (const item of items) {
      if (item.kind === 'tool') {
        const info = parseToolInfo(item.text)
        if (info.badge === 'Read' && info.target) fileSet.add(info.target)
      }
    }
    return fileSet.size
  }, [items])

  const latestAction = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'tool') {
        const info = parseToolInfo(item.text)
        return `${info.badge} ${info.toolName}${info.target ? ` · ${info.target}` : ''}`
      }
      if (item.kind === 'text') {
        return item.text.slice(0, 60)
      }
    }
    return ''
  }, [items])

  const extractedError = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'error') return cleanErrorMessage(items[i].text)
      if (items[i].text.includes('{"error"')) return cleanErrorMessage(items[i].text)
    }
    return detail ? cleanErrorMessage(detail) : ''
  }, [items, detail])

  useEffect(() => {
    onSummary?.({
      state,
      filesCount,
      systemsCount: drafts.newest?.systemCount ?? 0,
      latestAction,
      error: extractedError || detail,
    })
  }, [state, filesCount, drafts.newest?.systemCount, latestAction, extractedError, detail, onSummary])

  const handleFallbackRetry = async () => {
    try {
      if (run.kind === 'run') {
        const brief = await window.ambio.mappingBrief()
        const messageId = crypto.randomUUID()
        await useSheetStore.getState().sendToAgent(run.workspaceId, `${MAPPING_CONTRACT}\n\n${brief}`, [], null, messageId, [], { threadId: messageId, mode: 'propose' })
        await window.ambio.deliverWorkOrder({ workspaceId: run.workspaceId, messageId, hostId: run.hostId, ...(run.model ? { model: run.model } : {}) })
        const newRun: MappingRun = { ...run, messageId }
        rememberMappingRun(newRun, run.workspaceId)
        window.location.reload()
      } else if (run.kind === 'chat') {
        const providers = await window.ambio.chatProviders().catch(() => [])
        const providerId = providers[0]?.id || 'anthropic'
        const brief = await window.ambio.mappingBrief()
        const conversation = await window.ambio.createChat(run.workspaceId, providerId, run.model)
        await window.ambio.sendChat({ conversationId: conversation.id, text: `${MAPPING_CONTRACT}\n\n${brief}`, mode: 'propose', ...(run.model ? { model: run.model } : {}) })
        const newRun: MappingRun = { kind: 'chat', workspaceId: run.workspaceId, conversationId: conversation.id, label: run.label, model: run.model }
        rememberMappingRun(newRun, run.workspaceId)
        window.location.reload()
      }
    } catch (e) {
      console.error('Fallback retry error', e)
    }
  }

  const stop = async () => {
    if (run.kind === 'chat') await window.ambio.stopChat(run.conversationId)
    else if (current) await window.ambio.stopDeliveryRun(run.workspaceId, current.key)
  }

  const label = run.kind === 'chat' ? 'Ambio chat' : run.label
  const isCurrentDraft = Boolean(drafts.newest && drafts.newest.updatedAt >= (current?.startedAt ?? startTime))
  const systemsCount = isCurrentDraft ? (drafts.newest?.systemCount ?? 0) : 0
  const elapsedFormatted = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <section className="ambio-map-activity" aria-label="Mapping activity" data-state={state}>
      <header className="ambio-map-activity__header">
        <div className="ambio-map-activity__title-group">
          <span className="ambio-map-activity__pulse" data-state={state} aria-hidden="true" />
          <div className="ambio-map-activity__heading">
            <strong>
              {state === 'working' ? `${label} is mapping the project`
                : state === 'waiting' ? `${label} is waiting for you`
                  : state === 'done' ? `${label} finished its run`
                    : state === 'stopped' ? 'Mapping stopped'
                      : 'Mapping did not finish'}
            </strong>
            <small>
              {[
                systemsCount > 0 ? `${systemsCount} ${systemsCount === 1 ? 'system' : 'systems'} drawn so far` : 'No systems drawn yet',
                filesCount > 0 ? `${filesCount} ${filesCount === 1 ? 'file' : 'files'} inspected` : null,
                elapsed > 0 && (state === 'working' || state === 'waiting') ? elapsedFormatted : null,
              ].filter(Boolean).join(' · ')}
            </small>
          </div>
        </div>

        <div className="ambio-map-activity__controls">
          {state === 'working' || state === 'waiting' ? (
            <button type="button" className="ambio-connect__secondary" onClick={() => { void stop() }}>
              Stop
            </button>
          ) : state === 'failed' ? null : (
            <button
              type="button"
              className="ambio-connect__secondary"
              onClick={() => {
                rememberMappingRun(null, run.workspaceId)
                onDismiss()
              }}
            >
              Choose again
            </button>
          )}
        </div>
      </header>

      {state === 'failed' && (
        <div className="ambio-map-activity__failure-card" role="alert">
          <div className="ambio-map-activity__failure-head">
            <div className="ambio-map-activity__failure-info">
              <h4>Mapping did not finish</h4>
              <p className="ambio-map-activity__failure-desc">
                {extractedError || detail || 'The agent process exited before completing the architecture map.'}
              </p>
            </div>
          </div>
          <div className="ambio-map-activity__failure-recovery">
            <p className="ambio-map-activity__failure-hint">
              You can retry now with {label}, or switch to Ambio chat or another agent.
            </p>
            <div className="ambio-map-activity__failure-options">
              <button
                type="button"
                className="ambio-connect__primary"
                onClick={() => {
                  if (onRetry) onRetry()
                  else void handleFallbackRetry()
                }}
              >
                Retry with {label}
              </button>
              <button
                type="button"
                className="ambio-connect__secondary"
                onClick={() => {
                  rememberMappingRun(null, run.workspaceId)
                  onDismiss()
                }}
              >
                Choose again
              </button>
              {systemsCount > 0 && (
                <button
                  type="button"
                  className="ambio-choose__quiet"
                  disabled={drafts.discarding}
                  onClick={() => { void drafts.discard() }}
                >
                  Discard partial map ({systemsCount} {systemsCount === 1 ? 'system' : 'systems'})
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div
          ref={log}
          className="ambio-map-activity__feed"
          tabIndex={0}
          role="region"
          aria-label="Live agent activity"
          onScroll={() => {
            const el = log.current
            if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          <ol className="ambio-map-activity__list">
            {items.map(item => {
              const toolInfo = item.kind === 'tool' ? parseToolInfo(item.text) : null
              return (
                <li key={item.id} className={`ambio-map-activity__row ambio-map-activity__row--${item.kind}`}>
                  {item.kind === 'tool' && toolInfo ? (
                    <div className="ambio-map-activity__tool">
                      <span className={`ambio-map-activity__badge ambio-map-activity__badge--${toolInfo.badge.toLowerCase()}`}>
                        {toolInfo.badge}
                      </span>
                      <strong className="ambio-map-activity__tool-name">{toolInfo.toolName}</strong>
                      {toolInfo.target && <span className="ambio-map-activity__tool-target">{toolInfo.target}</span>}
                      {/* Preserves raw exact text for e2e tests & accessibility */}
                      <span className="ambio-map-activity__raw-target">{item.text}</span>
                    </div>
                  ) : item.kind === 'thinking' ? (
                    <div className="ambio-map-activity__thinking">
                      <span className="ambio-map-activity__badge ambio-map-activity__badge--think">Reasoning</span>
                      <span className="ambio-map-activity__thought-text">{item.text}</span>
                    </div>
                  ) : item.kind === 'error' ? (
                    <div className="ambio-map-activity__error-row">
                      <span className="ambio-map-activity__badge ambio-map-activity__badge--error">Error</span>
                      <span className="ambio-map-activity__error-text">{cleanErrorMessage(item.text)}</span>
                    </div>
                  ) : (
                    <div className="ambio-map-activity__speech">
                      <p>{item.text}</p>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}
