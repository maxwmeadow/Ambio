import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_DELIVERY, DESTINATION_GUIDE, WATCHING_DELIVERY, type DeliveryReadinessResult, chooseDeliveryHost, type DeliveryEvent, type DeliveryHost, type DeliveryRun } from '../../shared/agentDelivery'
import { archdApi } from '../archdEndpoint.ts'
import { InboxIcon } from './InboxIcon'
import { rememberDeliveryHost, rememberedDeliveryHost } from '../projectLocalState'

export function useAgentDelivery(workspaceId: string, isOpen: boolean, rootPath?: string) {
  const [hosts, setHosts] = useState<DeliveryHost[]>([])
  const [hostId, setHostIdState] = useState('')
  const [installedIds, setInstalledIds] = useState<string[]>([])
  // Once the user picks a destination in this panel, a refresh must not move it.
  const chosen = useRef(false)
  const setHostId = (value: string) => {
    chosen.current = true
    setHostIdState(value)
    rememberDeliveryHost(workspaceId, value)
  }
  const [runs, setRuns] = useState<DeliveryRun[]>([])
  // What each run has said and done, by run key, for the turn it answers.
  const [events, setEvents] = useState<Record<string, DeliveryEvent[]>>({})
  const seen = useRef<Record<string, DeliveryEvent[]>>({})
  const [notice, setNotice] = useState('')
  // Sessions the user told to watch Ambio, waiting on the inbox right now,
  // by the host each belongs to.
  const [watchingHosts, setWatchingHosts] = useState<string[]>([])
  const watchers = watchingHosts.length
  const [busy, setBusy] = useState('')
  const lock = useRef(false)
  const workspace = useRef(workspaceId)
  workspace.current = workspaceId
  useEffect(() => { chosen.current = false; setHostIdState(''); setInstalledIds([]); setRuns([]); setEvents({}); seen.current = {}; setNotice('') }, [workspaceId])
  useEffect(() => {
    if (!isOpen) return
    let active = true
    // Start on an agent that can receive the request: the one used last here,
    // else one connected now, else one Ambio is installed in.
    const installed = Promise.resolve().then(() => window.ambio.listAgentHosts(rootPath))
      .then(items => items.filter(item => item.configured && item.workflowInstalled).map(item => item.id), () => [] as string[])
    const live = fetch(`${archdApi()}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
      .then(response => response.ok ? response.json() as Promise<{ connections?: Array<{ hostId: string }> }> : {})
      .then(body => (body as { connections?: Array<{ hostId: string }> }).connections?.map(item => item.hostId) ?? [], () => [] as string[])
    const watching = () => fetch(`${archdApi()}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
      .then(response => response.ok ? response.json() as Promise<{ connections?: Array<{ hostId: string; watchingUntil?: number }> }> : {})
      .then(body => ((body as { connections?: Array<{ hostId: string; watchingUntil?: number }> }).connections ?? []).filter(item => (item.watchingUntil ?? 0) > Date.now()).map(item => item.hostId), () => [] as string[])
    void window.ambio.listDeliveryHosts().then(async items => {
      const [installedNow, liveNow, watchingNow] = await Promise.all([installed, live, watching()])
      if (!active) return
      setHosts(items)
      setInstalledIds([...new Set([...liveNow, ...installedNow])])
      setWatchingHosts(watchingNow)
      if (!chosen.current) {
        const remembered = rememberedDeliveryHost(workspaceId)
        // A session that is watching right now is where the conversation was
        // last happening; go back to it.
        setHostIdState(remembered === WATCHING_DELIVERY && watchingNow.length > 0 ? WATCHING_DELIVERY
          : chooseDeliveryHost({ hosts: items, remembered: remembered === WATCHING_DELIVERY ? null : remembered, liveIds: liveNow, installedIds: installedNow }))
      }
    }, () => { if (active) setNotice('Agent destinations unavailable. You can still save and copy a handoff.') })
    // A run in progress is followed closely; otherwise the list is only kept current.
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      let live = false
      try {
        const items = await window.ambio.listDeliveryRuns(workspaceId)
        if (!active) return
        setRuns(items)
        for (const run of items) {
          const working = run.state === 'starting' || run.state === 'running' || run.state === 'stopping'
          live ||= working
          // Read a finished run once more, for what it said last.
          const known = seen.current[run.key]
          if (!working && known && (known as DeliveryEvent[] & { settled?: boolean }).settled) continue
          const fresh = await window.ambio.listDeliveryEvents?.(workspaceId, run.key, 0) ?? []
          if (!active) return
          const next = Object.assign(fresh, { settled: !working })
          if (!known || known.length !== fresh.length || !working) { seen.current = { ...seen.current, [run.key]: next }; setEvents(seen.current) }
        }
      } catch { if (active) setNotice('Agent run status unavailable. Check the host before sending again.') }
      const watchingNow = await watching()
      if (active) setWatchingHosts(current => current.length === watchingNow.length && current.every((host, index) => host === watchingNow[index]) ? current : watchingNow)
      if (active) timer = setTimeout(() => { void refresh() }, live ? 1000 : 3000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [workspaceId, isOpen, rootPath])
  const deliver = async (messageId: string, destination = hostId, model?: string) => {
    if (!destination || lock.current) return
    lock.current = true; setBusy(messageId)
    try {
      const result = await window.ambio.deliverWorkOrder({ workspaceId, messageId, hostId: destination, ...(model ? { model } : {}) })
      if (workspace.current !== workspaceId) return
      // A run says where it stands on its turn; the notice is for routes that need the user.
      setNotice(result.run ? '' : result.detail)
      if (result.run) setRuns(items => [...items.filter(item => item.key !== result.run!.key), result.run!])
    } catch (error) {
      if (workspace.current === workspaceId) setNotice(`Work order saved; delivery did not start. ${error instanceof Error ? error.message : String(error)}`)
    } finally { lock.current = false; setBusy('') }
  }
  const stop = async (run: DeliveryRun) => {
    try {
      await window.ambio.stopDeliveryRun(workspaceId, run.key)
      if (workspace.current === workspaceId) setRuns(await window.ambio.listDeliveryRuns(workspaceId))
    } catch (error) { if (workspace.current === workspaceId) setNotice(String(error)) }
  }
  return { hosts, hostId, setHostId, installedIds, runs, events, watchers, watchingHosts, notice, setNotice, busy, deliver, stop }
}

export function deliveryAction(host?: DeliveryHost, hostId = '', watchingHosts: string[] = []): string {
  if (hostId.startsWith(CHAT_DELIVERY)) return 'Send to Ambio chat'
  if (hostId === WATCHING_DELIVERY) return 'Send to watching session'
  if (host && watchingHosts.includes(host.id)) return `Send to the watching ${host.label} session`
  if (!host) return 'Send to inbox'
  return host.route === 'run' ? `Start ${host.label}` : host.route === 'open' ? `Copy + open ${host.label}` : `Copy for ${host.label}`
}

export function AgentDeliveryDestination({ hosts, hostId, installedIds, watchers = 0, watchingHosts = [], onChange, disabled, rootPath, onManageConnections, chatServices, onSetUpChat, fixed, children }: {
  hosts: DeliveryHost[]; hostId: string; installedIds: string[]; watchers?: number; watchingHosts?: string[]; onChange: (value: string) => void; disabled: boolean; rootPath: string
  onManageConnections?: () => void
  /** Ambio chat's model services, offered when a conversation can start with one; undefined hides Ambio chat. */
  chatServices?: { id: string; label: string }[]
  onSetUpChat?: () => void
  /** The agent an open conversation is bound to, shown instead of the picker. */
  fixed?: { label: string; guideId: string }
  /** Shown joined to the picker's right edge: the model choice. */
  children?: ReactNode
}) {
  const [seen, setSeen] = useState(seenGuides)
  const host = hosts.find(item => item.id === hostId)
  const chat = hostId.startsWith(CHAT_DELIVERY)
  const watching = hostId === WATCHING_DELIVERY || watchingHosts.includes(hostId)
  const guideId = fixed?.guideId ?? (chat ? CHAT_DELIVERY : watching ? WATCHING_DELIVERY : hostId)
  const name = fixed?.label ?? (chat ? chatServices?.find(service => `${CHAT_DELIVERY}:${service.id}` === hostId)?.label ?? 'Ambio chat'
    : hostId === WATCHING_DELIVERY ? 'Session watching Ambio' : host?.label ?? 'Copy the handoff myself')
  // A host with a session watching gets the message in that session.
  const option = (item: DeliveryHost) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{watchingHosts.includes(item.id) ? ' · attached' : item.route !== 'run' && !installedIds.includes(item.id) ? ' · Ambio not added' : ''}</option>
  const started = hosts.filter(item => item.route === 'run' && item.available)
  const inApps = hosts.filter(item => item.route !== 'run')
  const missing = hosts.filter(item => item.route === 'run' && !item.available)
  // The picker, the info button's guide and the first-use introduction are
  // one choice: changing any of them changes the destination.
  const picker = (label: string, id?: string, compact = false) => fixed
    ? compact
      ? <span className="ambio-inbox__delivery-fixed" id={id} title="Start a new conversation to use another agent.">{fixed.label}</span>
      : <p className="ambio-inbox__delivery-fixed" id={id}>{fixed.label}<small>Start a new conversation to use another agent.</small></p>
    : <select id={id} aria-label={label} value={hostId} disabled={disabled} onChange={event => {
      if (event.target.value === CHAT_DELIVERY) onSetUpChat?.()
      else onChange(event.target.value)
    }}>
      {chatServices && <optgroup label="Built into Ambio">
        {chatServices.length ? chatServices.map(service => <option key={service.id} value={`${CHAT_DELIVERY}:${service.id}`}>{service.label}</option>)
          : <option value={CHAT_DELIVERY}>Ambio chat · set up a model service…</option>}
      </optgroup>}
      {started.length > 0 && <optgroup label="Ambio runs it for you">{started.map(option)}</optgroup>}
      {inApps.length > 0 && <optgroup label="Opens in your app">{inApps.map(option)}</optgroup>}
      {missing.length > 0 && <optgroup label="Not found on this computer">{missing.map(option)}</optgroup>}
      {/* A session told to watch keeps its own conversation; offered while one is waiting, or when it was the choice. */}
      {(watchers > 0 || hostId === WATCHING_DELIVERY) && <option value={WATCHING_DELIVERY}>{watchers > 0 ? `Session watching Ambio${watchers > 1 ? ` (${watchers})` : ''}` : 'Session watching Ambio · none right now'}</option>}
      <option value="">Copy the handoff myself</option>
    </select>
  // Each kind of agent works differently, so the first time one is chosen its
  // guide is put in front of the user until they confirm they have read it.
  const introduce = hosts.length > 0 && !!DESTINATION_GUIDE[guideId] && !seen.includes(guideId)
  // One control in the message box's row: the agent, its model joined to it, and the guide.
  return <div className="ambio-inbox__agent-picker">
    <div className="ambio-inbox__agent-group" data-fixed={fixed ? true : undefined}>{picker('Work-order destination', 'ambio-delivery-select', true)}{children}</div>
    <DestinationGuidePopover name={name} guideId={guideId} picker={picker('Agent to read about')} />
    {introduce && <DestinationIntroduction name={name} guideId={guideId} picker={picker('Agent to read about')} onConfirm={() => setSeen(markGuideSeen(guideId))} />}
  </div>
}

/** The chosen agent's readiness, one line above the picker. */
export function DeliveryReadiness({ readiness, onFix }: { readiness: DeliveryReadinessResult; onFix?: () => void }) {
  return <section className="ambio-inbox__handoff" aria-label="Agent readiness">
    <div className="ambio-inbox__handoff-status"><span className={`ambio-inbox__signal ambio-inbox__signal--${readiness.tone}`} />
      <span title={readiness.text}>{readiness.text}</span>
      {readiness.fix && onFix && <button type="button" onClick={onFix}>Agents</button>}
    </div>
  </section>
}

/** Which agents' guides this user has confirmed, on this machine. */
const GUIDES_SEEN_KEY = 'ambio:destination-guides-seen'
function seenGuides(): string[] {
  try { const saved = JSON.parse(localStorage.getItem(GUIDES_SEEN_KEY) ?? '[]'); return Array.isArray(saved) ? saved.filter(item => typeof item === 'string') : [] } catch { return [] }
}
function markGuideSeen(guideId: string): string[] {
  const next = [...new Set([...seenGuides(), guideId])]
  try { localStorage.setItem(GUIDES_SEEN_KEY, JSON.stringify(next)) } catch { /* shown again next time */ }
  return next
}

/** How an agent works from the panel and what it can do, as numbered steps and a list. */
function DestinationGuideBody({ guideId }: { guideId: string }) {
  const guide = DESTINATION_GUIDE[guideId]
  if (!guide) return null
  return <div className="ambio-guide__body">
    <section><h3>What you need</h3><ul>{guide.need.map(item => <li key={item}><span aria-hidden="true"><InboxIcon name="plus" size={11} /></span>{item}</li>)}</ul></section>
    <section><h3>How it works</h3><ol>{guide.how.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span>{step}</li>)}</ol></section>
    <section><h3>What it can do</h3><ul>{guide.can.map(item => <li key={item}><span aria-hidden="true"><InboxIcon name="check" size={12} /></span>{item}</li>)}</ul></section>
  </div>
}

/**
 * The info button beside the picker: the chosen agent's guide, with the
 * same picker inside so another agent can be read about and chosen.
 */
function DestinationGuidePopover({ name, guideId, picker }: { name: string; guideId: string; picker: ReactNode }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={anchor} className="ambio-inbox__guide" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-inbox__guide-button" aria-label="How each agent works here" aria-expanded={open} title="How each agent works here" onClick={() => setOpen(!open)}><InboxIcon name="info" size={14} /></button>
    {open && <section className="ambio-guide ambio-guide--popover" role="dialog" aria-label="How each agent works here">
      <header className="ambio-guide__header"><span className="ambio-guide__eyebrow">How it works here</span><h2>{name}</h2>
        <button type="button" className="ambio-guide__close" aria-label="Close" onClick={() => setOpen(false)}><InboxIcon name="close" size={14} /></button></header>
      <div className="ambio-guide__picker"><span>Agent</span>{picker}</div>
      <DestinationGuideBody guideId={guideId} />
    </section>}
  </div>
}

/**
 * The first time an agent is chosen: its guide, full screen, until the user
 * confirms. The same picker is offered so they can choose another instead.
 */
function DestinationIntroduction({ name, guideId, picker, onConfirm }: { name: string; guideId: string; picker: ReactNode; onConfirm: () => void }) {
  return createPortal(<div className="ambio-guide-backdrop" onKeyDown={event => {
    // Confirming is the only way past; Escape must not close the panel behind it.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation() }
  }}>
    <section className="ambio-guide ambio-guide--intro" role="dialog" aria-modal="true" aria-label={`Before you use ${name}`}>
      <header className="ambio-guide__header"><span className="ambio-guide__eyebrow">Before you use this agent</span><h2>{name}</h2>
        <p>Every agent works a little differently from this panel. Here is what to expect from this one.</p></header>
      <div className="ambio-guide__picker"><span>Agent</span>{picker}</div>
      <DestinationGuideBody guideId={guideId} />
      <footer className="ambio-guide__footer">
        <p><span className="ambio-guide__info-mark"><InboxIcon name="info" size={14} /></span>To read this again, press the info button next to the agent in the message box.</p>
        <button type="button" className="ambio-guide__confirm" autoFocus onClick={onConfirm}>Got it</button>
      </footer>
    </section>
  </div>, document.body)
}

/** How many of a run's latest events the turn shows while it works. */
const ACTIVITY_SHOWN = 6

/** A duration as a person says it: "40s", "3 min", "1 h 5 min". */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** A run that has not ended yet. */
export const runWorking = (run?: DeliveryRun) => !!run && (run.state === 'starting' || run.state === 'running' || run.state === 'stopping')

/**
 * Where an unanswered turn stands, in one line under it: the agent working
 * (with what it is doing), or how its run ended. Stopping is the message
 * box's job; once the agent answers, its reply is the record.
 */
export function AgentDeliveryStatus({ run, hosts, events = [], onRetry }: {
  run: DeliveryRun; hosts: DeliveryHost[]; events?: DeliveryEvent[]; onRetry?: () => void
}) {
  const label = hosts.find(host => host.id === run.hostId)?.label ?? run.hostId
  const working = runWorking(run)
  // A clock, so a long turn reads as alive or as stuck instead of as nothing.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [working])
  const lastSign = Math.max(run.startedAt, events.at(-1)?.at ?? 0)
  const quiet = working ? now - lastSign : 0
  // While it works, the latest of what it does; once it ends, why it ended.
  const shown = working ? events.slice(-ACTIVITY_SHOWN) : events.filter(event => event.kind === 'error').slice(-2)
  const line = working ? `${label} is working${run.resumed ? ', continuing its earlier session' : ''} · ${elapsed(now - run.startedAt)}`
    : run.state === 'stopped' ? `${label} was stopped.`
      : run.state === 'completed' ? `${label} finished without replying.`
        : `${label} stopped without an answer.`
  return <div className="ambio-inbox__turn-status" data-state={working ? 'working' : 'ended'} role="status">
    <p><span className="ambio-inbox__turn-pulse" aria-hidden="true" />{line}</p>
    {quiet > 60000 && <p className="ambio-inbox__turn-quiet">Nothing new for {elapsed(quiet)}. Long commands and background tasks can take a while; Stop if it should be done by now.</p>}
    {shown.length > 0 && <ol className="ambio-inbox__activity" aria-label="What the agent is doing">
      {shown.map((event, index) => <li key={`${event.at}:${index}`} data-kind={event.kind}>{event.text}</li>)}
    </ol>}
    <div className="ambio-inbox__turn-actions">
      {!working && onRetry && <button type="button" className="ambio-inbox__turn-action" onClick={onRetry}>Try again</button>}
      <button type="button" className="ambio-inbox__turn-link" onClick={() => window.ambio.showInFolder(run.logPath)}>Show output</button>
    </div>
  </div>
}
