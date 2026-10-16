import { useEffect, useRef, useState } from 'react'
import type { AgentHostInfo } from '../../../electron/preload'
import type { DeliveryEvent, DeliveryHost, DeliveryRun } from '../../shared/agentDelivery'
import type { ChatProvider, ChatSnapshot } from '../../shared/agentChat'
import { useSheetStore } from '../store/sheetStore'
import { CHAT_PROVIDERS_CHANGED } from '../components/AgentChatPanel'
import { useProposalDrafts } from '../components/ProposalDraftProgress'

/**
 * Mapping a project with an agent Ambio runs itself: Ambio chat, or a CLI on
 * this computer. Nothing to install or restart; the run is an ordinary
 * Propose turn, so it also appears as a conversation in the agent panel.
 * Agents in other apps keep the install → restart → command path.
 */

/** A mapping Ambio started, kept per project so reopening setup follows it. */
export type MappingRun =
  | { kind: 'run'; workspaceId: string; messageId: string; hostId: string; label: string }
  | { kind: 'chat'; workspaceId: string; conversationId: string; label: string }

const runKey = (workspaceId: string) => `ambio:setup-mapping:${workspaceId}`

export function rememberedMappingRun(workspaceId: string): MappingRun | null {
  try {
    const saved = JSON.parse(localStorage.getItem(runKey(workspaceId)) ?? 'null')
    return saved && saved.workspaceId === workspaceId && (saved.kind === 'run' || saved.kind === 'chat') ? saved : null
  } catch { return null }
}

function rememberMappingRun(run: MappingRun | null, workspaceId: string): void {
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
export type MappingChoice = { label: string; kind: 'chat' | 'run' | 'setup' | 'app' } | null

/** Ambio chat's services and the CLIs on this computer, kept current as services change. */
export function useRunnableChoices(): RunnableChoice[] | null {
  const [choices, setChoices] = useState<RunnableChoice[] | null>(null)
  useEffect(() => {
    let active = true
    const load = async () => {
      const [targets, providers] = await Promise.all([
        window.ambio.listDeliveryHosts().catch(() => [] as DeliveryHost[]),
        window.ambio.chatProviders().catch(() => [] as ChatProvider[]),
      ])
      if (!active) return
      setChoices([
        ...targets.filter(target => target.route === 'run' && target.available).map(host => ({ id: host.id, label: host.label, kind: 'run' as const, host })),
        ...providers.map(provider => ({ id: `chat:${provider.id}`, label: 'Ambio chat', kind: 'chat' as const, provider })),
        ...(providers.length ? [] : [{ id: CHAT_SETUP, label: 'Ambio chat', kind: 'setup' as const }]),
      ])
    }
    void load()
    window.addEventListener(CHAT_PROVIDERS_CHANGED, load)
    return () => { active = false; window.removeEventListener(CHAT_PROVIDERS_CHANGED, load) }
  }, [])
  return choices
}

/**
 * What a mapping turn is, ahead of the brief. A Propose turn's usual contract
 * asks for a sheet; a mapping writes a proposed map with edit_systems, which
 * the user reviews, so it says that instead.
 */
export const MAPPING_CONTRACT = 'This is a mapping request. Do not change any code. Follow the brief below and propose the architecture with edit_systems; the human reviews the proposal before it becomes the map. Do not draw a sheet for this.'

/**
 * Start mapping with an agent Ambio runs. Adding Ambio to the user's own
 * sessions of that CLI is attempted first when asked; it never blocks the run.
 * Returns the run, and a warning when the add did not work.
 */
export async function startMapping({ choice, workspaceId, projectRoot, installer, model }: {
  choice: Exclude<RunnableChoice, { kind: 'setup' }>; workspaceId: string; projectRoot: string; installer?: AgentHostInfo; model?: string
}): Promise<{ run: MappingRun; warning?: string }> {
  let warning: string | undefined
  if (installer) {
    const outcome = await window.ambio.installAgent(installer.id, projectRoot).catch(failure => ({ ok: false, detail: String(failure) }))
    if (!outcome.ok) warning = `Ambio could not be added to your own ${choice.label} sessions: ${outcome.detail} The mapping still runs.`
  }
  const brief = await window.ambio.mappingBrief()
  let run: MappingRun
  if (choice.kind === 'chat') {
    const conversation = await window.ambio.createChat(workspaceId, choice.provider.id, model)
    await window.ambio.sendChat({ conversationId: conversation.id, text: `${MAPPING_CONTRACT}

${brief}`, mode: 'propose', ...(model ? { model } : {}) })
    run = { kind: 'chat', workspaceId, conversationId: conversation.id, label: choice.label }
  } else {
    const messageId = crypto.randomUUID()
    await useSheetStore.getState().sendToAgent(workspaceId, `${MAPPING_CONTRACT}

${brief}`, [], null, messageId, [], { threadId: messageId, mode: 'propose' })
    await window.ambio.deliverWorkOrder({ workspaceId, messageId, hostId: choice.host.id, ...(model ? { model } : {}) })
    run = { kind: 'run', workspaceId, messageId, hostId: choice.host.id, label: choice.label }
  }
  rememberMappingRun(run, workspaceId)
  return { run, warning }
}

export type MappingState = 'working' | 'done' | 'failed' | 'stopped' | 'waiting'

/** What the mapping agent is doing, live, with a way to stop it. */
export function MappingActivity({ run, onDismiss, onState }: { run: MappingRun; onDismiss: () => void; onState?: (state: MappingState) => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [state, setState] = useState<MappingState>('working')
  const [detail, setDetail] = useState('')
  const [current, setCurrent] = useState<DeliveryRun | null>(null)
  const after = useRef(0)
  const drafts = useProposalDrafts(run.workspaceId, 2000)
  useEffect(() => {
    let active = true
    // A finished run is not polled again; for Ambio chat that would wake its agent.
    let finished = false
    after.current = 0
    const poll = async () => {
      if (finished) return
      try {
        if (run.kind === 'chat') {
          const snapshot: ChatSnapshot = await window.ambio.chatSnapshot(run.conversationId)
          if (!active) return
          const parts = snapshot.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts)
          setLines(parts.slice(-6).map(part => part.kind === 'tool' ? `${part.tool ?? 'tool'}${part.state ? ` · ${part.state}` : ''}` : part.text.split('\n').find(line => line.trim()) ?? '').filter(Boolean))
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
            // The cursor is how many events have been read, not a time.
            after.current += events.length
            setLines(previous => [...previous, ...events.map(event => event.text.split('\n').find(line => line.trim()) ?? '')].filter(Boolean).slice(-6))
          }
          setState(latest.state === 'running' || latest.state === 'starting' || latest.state === 'stopping' ? 'working'
            : latest.state === 'completed' ? 'done' : latest.state === 'stopped' ? 'stopped' : 'failed')
          setDetail(latest.state === 'completed' ? '' : latest.detail)
          finished = !['running', 'starting', 'stopping'].includes(latest.state)
        }
      } catch (failure) { if (active) setDetail(failure instanceof Error ? failure.message : String(failure)) }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 1500)
    return () => { active = false; clearInterval(timer) }
  }, [run])
  useEffect(() => { onState?.(state) }, [state])
  const stop = async () => {
    if (run.kind === 'chat') await window.ambio.stopChat(run.conversationId)
    else if (current) await window.ambio.stopDeliveryRun(run.workspaceId, current.key)
  }
  const label = run.kind === 'chat' ? 'Ambio chat' : run.label
  return <section className="ambio-map-with ambio-map-with--activity" aria-label="Mapping activity" data-state={state}>
    <header><span className="ambio-map-with__pulse" aria-hidden="true" />
      <span className="ambio-map-with__heading">
        <strong>{state === 'working' ? `${label} is mapping the project` : state === 'waiting' ? `${label} is waiting for you` : state === 'done' ? `${label} finished its run` : state === 'stopped' ? 'Mapping stopped' : 'Mapping did not finish'}</strong>
        <small>{drafts.newest ? `${drafts.newest.systemCount} ${drafts.newest.systemCount === 1 ? 'system' : 'systems'} drawn so far` : 'Reading the code; no systems drawn yet'}</small>
      </span>
      {state === 'working' || state === 'waiting'
        ? <button type="button" className="ambio-connect__secondary" onClick={() => { void stop() }}>Stop</button>
        : <>
          {drafts.newest && <button type="button" className="ambio-choose__quiet" disabled={drafts.discarding} onClick={() => { void drafts.discard() }}>Discard partial map</button>}
          <button type="button" className="ambio-connect__secondary" onClick={() => { rememberMappingRun(null, run.workspaceId); onDismiss() }}>Choose again</button>
        </>}
    </header>
    {lines.length > 0 && <ol className="ambio-map-with__lines" aria-live="polite">{lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ol>}
    {detail && <p className="ambio-map-with__copy">{detail}</p>}
  </section>
}
