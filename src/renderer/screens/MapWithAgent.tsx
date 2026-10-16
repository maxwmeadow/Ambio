import { useEffect, useRef, useState } from 'react'
import type { AgentHostInfo } from '../../../electron/preload'
import type { DeliveryEvent, DeliveryHost, DeliveryRun } from '../../shared/agentDelivery'
import type { ChatProvider, ChatSnapshot } from '../../shared/agentChat'
import { useSheetStore } from '../store/sheetStore'
import { workOrderNote } from '../components/inboxModel'
import { OPEN_MODEL_SERVICES, CHAT_PROVIDERS_CHANGED } from '../components/AgentChatPanel'

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

type Choice = { id: string; label: string; kind: 'chat'; provider: ChatProvider } | { id: string; label: string; kind: 'run'; host: DeliveryHost }
  // Ambio chat before a model service exists: offered so it is never invisible.
  | { id: string; label: string; kind: 'setup' }

const CHAT_SETUP = 'chat-setup'

export function MapWithAgent({ workspaceId, projectRoot, agentHosts, onStarted }: {
  workspaceId: string
  projectRoot: string
  /** Ambio's installers, to offer adding Ambio to the user's own sessions of the chosen CLI. */
  agentHosts: AgentHostInfo[]
  onStarted: (run: MappingRun) => void
}) {
  const [choices, setChoices] = useState<Choice[] | null>(null)
  const [chosen, setChosen] = useState('')
  const [addToSessions, setAddToSessions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const load = async () => {
      const [targets, providers] = await Promise.all([
        window.ambio.listDeliveryHosts().catch(() => [] as DeliveryHost[]),
        window.ambio.chatProviders().catch(() => [] as ChatProvider[]),
      ])
      if (!active) return
      const next: Choice[] = [
        ...providers.map(provider => ({ id: `chat:${provider.id}`, label: `Ambio chat · ${provider.name} · ${provider.model}`, kind: 'chat' as const, provider })),
        ...targets.filter(target => target.route === 'run' && target.available).map(host => ({ id: host.id, label: host.label, kind: 'run' as const, host })),
        ...(providers.length ? [] : [{ id: CHAT_SETUP, label: 'Ambio chat · your own API key (set up first)', kind: 'setup' as const }]),
      ]
      setChoices(next)
      // A service just added replaces the setup choice that asked for it.
      setChosen(current => current === CHAT_SETUP && providers.length ? next[0].id
        : next.some(choice => choice.id === current) ? current : next[0]?.id ?? '')
    }
    void load()
    window.addEventListener(CHAT_PROVIDERS_CHANGED, load)
    return () => { active = false; window.removeEventListener(CHAT_PROVIDERS_CHANGED, load) }
  }, [])
  const choice = choices?.find(item => item.id === chosen)
  // Adding Ambio to a CLI serves the user's own sessions; Ambio's runs do not need it.
  const installer = choice?.kind === 'run' ? agentHosts.find(host => host.id === choice.host.id && host.modality === 'cli') : undefined
  const offerInstall = !!installer && !(installer.configured && installer.workflowInstalled)

  const start = async () => {
    if (!choice || busy) return
    if (choice.kind === 'setup') { window.dispatchEvent(new Event(OPEN_MODEL_SERVICES)); return }
    setBusy(true); setError('')
    try {
      if (offerInstall && addToSessions) {
        // The mapping does not wait on this; a failure is said and the run goes ahead.
        const outcome = await window.ambio.installAgent(installer!.id, projectRoot).catch(failure => ({ ok: false, detail: String(failure) }))
        if (!outcome.ok) setError(`Ambio could not be added to your own ${choice.label} sessions: ${outcome.detail} The mapping still runs.`)
      }
      const brief = await window.ambio.mappingBrief()
      let run: MappingRun
      if (choice.kind === 'chat') {
        const conversation = await window.ambio.createChat(workspaceId, choice.provider.id)
        await window.ambio.sendChat({ conversationId: conversation.id, text: brief, mode: 'propose' })
        run = { kind: 'chat', workspaceId, conversationId: conversation.id, label: choice.label }
      } else {
        const messageId = crypto.randomUUID()
        await useSheetStore.getState().sendToAgent(workspaceId, workOrderNote('propose', brief), [], null, messageId, [], { threadId: messageId, mode: 'propose' })
        await window.ambio.deliverWorkOrder({ workspaceId, messageId, hostId: choice.host.id })
        run = { kind: 'run', workspaceId, messageId, hostId: choice.host.id, label: choice.label }
      }
      rememberMappingRun(run, workspaceId)
      onStarted(run)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  if (choices === null) return <section className="ambio-map-with" aria-label="Map with an agent Ambio runs"><p className="ambio-map-with__copy">Looking for agents Ambio can run…</p></section>
  return <section className="ambio-map-with" aria-label="Map with an agent Ambio runs">
    <h3>Let Ambio run it</h3>
    {choices.length === 0 ? <p className="ambio-map-with__copy">
      No agent Ambio can run was found. Install Claude Code, Codex or GitHub Copilot CLI and sign in.
    </p> : <>
      <p className="ambio-map-with__copy">Ambio starts the agent in this project and shows its progress here. Nothing to install or restart.</p>
      <div className="ambio-map-with__row">
        <select aria-label="Agent to map with" value={chosen} disabled={busy} onChange={event => setChosen(event.target.value)}>
          {choices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <button type="button" className="ambio-connect__primary" disabled={busy || !choice} onClick={() => { void start() }}>{busy ? 'Starting…' : choice?.kind === 'setup' ? 'Set up a model service' : `Map with ${choice?.kind === 'chat' ? 'Ambio chat' : choice?.label ?? 'this agent'}`}</button>
      </div>
      {choice?.kind === 'setup' && <p className="ambio-map-with__copy">Ambio chat uses a model service with your own API key (OpenAI, Anthropic, Google or a compatible one) and Ambio&rsquo;s tools, so it can map the project with nothing else installed. Add the service once in Settings → Agents, then come back here.</p>}
      {offerInstall && <label className="ambio-map-with__sessions">
        <input type="checkbox" checked={addToSessions} disabled={busy} onChange={event => setAddToSessions(event.target.checked)} />
        <span><strong>Also add Ambio to your own {choice!.label} sessions</strong>
          <small>Recommended. Your own sessions outside Ambio can then see this map, draw plans on it and take messages from the canvas. Ambio&rsquo;s runs work either way, and you can remove it any time in Settings → Agents.</small></span>
      </label>}
    </>}
    {error && <p className="ambio-map-with__error" role="alert">{error}</p>}
  </section>
}

/** What the mapping agent is doing, live, with a way to stop it. */
export function MappingActivity({ run, onDismiss }: { run: MappingRun; onDismiss: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [state, setState] = useState<'working' | 'done' | 'failed' | 'stopped' | 'waiting'>('working')
  const [detail, setDetail] = useState('')
  const [current, setCurrent] = useState<DeliveryRun | null>(null)
  const after = useRef(0)
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
            after.current = events[events.length - 1].at
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
  const stop = async () => {
    if (run.kind === 'chat') await window.ambio.stopChat(run.conversationId)
    else if (current) await window.ambio.stopDeliveryRun(run.workspaceId, current.key)
  }
  const label = run.kind === 'chat' ? 'Ambio chat' : run.label
  return <section className="ambio-map-with ambio-map-with--activity" aria-label="Mapping activity" data-state={state}>
    <header><span className="ambio-map-with__pulse" aria-hidden="true" />
      <strong>{state === 'working' ? `${label} is mapping the project` : state === 'waiting' ? `${label} is waiting for you` : state === 'done' ? `${label} finished its run` : state === 'stopped' ? 'Mapping stopped' : 'Mapping did not finish'}</strong>
      {state === 'working' || state === 'waiting'
        ? <button type="button" className="ambio-connect__secondary" onClick={() => { void stop() }}>Stop</button>
        : <button type="button" className="ambio-connect__secondary" onClick={() => { rememberMappingRun(null, run.workspaceId); onDismiss() }}>Choose again</button>}
    </header>
    {lines.length > 0 && <ol className="ambio-map-with__lines" aria-live="polite">{lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ol>}
    {detail && <p className="ambio-map-with__copy">{detail}</p>}
  </section>
}
