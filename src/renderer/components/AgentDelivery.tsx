import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_DELIVERY, DESTINATION_GUIDE, WATCHING_DELIVERY, chooseDeliveryHost, type DeliveryEvent, type DeliveryHost, type DeliveryRun } from '../../shared/agentDelivery'
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
  const deliver = async (messageId: string, destination = hostId) => {
    if (!destination || lock.current) return
    lock.current = true; setBusy(messageId)
    try {
      const result = await window.ambio.deliverWorkOrder({ workspaceId, messageId, hostId: destination })
      if (workspace.current !== workspaceId) return
      setNotice(result.detail)
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

export function AgentDeliveryDestination({ hosts, hostId, installedIds, watchers = 0, watchingHosts = [], onChange, disabled, rootPath, onManageConnections, chatServices, onSetUpChat, fixed }: {
  hosts: DeliveryHost[]; hostId: string; installedIds: string[]; watchers?: number; watchingHosts?: string[]; onChange: (value: string) => void; disabled: boolean; rootPath: string
  onManageConnections?: () => void
  /** Ambio chat's model services, offered when a conversation can start with one; undefined hides Ambio chat. */
  chatServices?: { id: string; label: string }[]
  onSetUpChat?: () => void
  /** The agent an open conversation is bound to, shown instead of the picker. */
  fixed?: { label: string; guideId: string }
}) {
  const [seen, setSeen] = useState(seenGuides)
  const host = hosts.find(item => item.id === hostId)
  const chat = hostId.startsWith(CHAT_DELIVERY)
  const watching = hostId === WATCHING_DELIVERY || watchingHosts.includes(hostId)
  const guideId = fixed?.guideId ?? (chat ? CHAT_DELIVERY : watching ? WATCHING_DELIVERY : hostId)
  const name = fixed?.label ?? (chat ? chatServices?.find(service => `${CHAT_DELIVERY}:${service.id}` === hostId)?.label ?? 'Ambio chat'
    : hostId === WATCHING_DELIVERY ? 'Session watching Ambio' : host?.label ?? 'Copy the handoff myself')
  // A host with a session watching gets the message in that session.
  const option = (item: DeliveryHost) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{!item.available ? ' · CLI not found' : watchingHosts.includes(item.id) ? ' · watching' : ''}</option>
  const connected = hosts.filter(item => installedIds.includes(item.id))
  const others = hosts.filter(item => !installedIds.includes(item.id))
  // What sending does is on the send button; the fine print waits on hover.
  const about = chat ? 'Ambio’s own agent, using your model service. Replies stream into this conversation.' : [
    watching
      ? 'Leaves the request for the session you told to watch Ambio. It answers in its own chat, with everything already said there.'
      : host?.detail ?? 'Save the request, then copy its handoff into the agent chat you choose.',
    ...(host?.route === 'run' && !watchingHosts.includes(hostId) ? [`Edits files in ${rootPath}. Uses your host account; usage may be billed. Stop the run before starting another here.`] : []),
  ].join(' ')
  // The picker, the info button's guide and the first-use introduction are
  // one choice: changing any of them changes the destination.
  const picker = (label: string, id?: string) => fixed
    ? <p className="ambio-inbox__delivery-fixed" id={id}>{fixed.label}<small>Start a new conversation to use another agent.</small></p>
    : <select id={id} aria-label={label} title={about} value={hostId} disabled={disabled} onChange={event => {
      if (event.target.value === CHAT_DELIVERY) onSetUpChat?.()
      else onChange(event.target.value)
    }}>
      {chatServices && <optgroup label="Built into Ambio">
        {chatServices.length ? chatServices.map(service => <option key={service.id} value={`${CHAT_DELIVERY}:${service.id}`}>{service.label}</option>)
          : <option value={CHAT_DELIVERY}>Ambio chat · set up a model service…</option>}
      </optgroup>}
      {connected.length > 0 && <optgroup label="Connected to Ambio">{connected.map(option)}</optgroup>}
      {others.length > 0 && <optgroup label="Not set up with Ambio">{others.map(option)}</optgroup>}
      {/* A session told to watch keeps its own conversation; offered while one is waiting, or when it was the choice. */}
      {(watchers > 0 || hostId === WATCHING_DELIVERY) && <option value={WATCHING_DELIVERY}>{watchers > 0 ? `Session watching Ambio${watchers > 1 ? ` (${watchers})` : ''}` : 'Session watching Ambio · none right now'}</option>}
      <option value="">Copy the handoff myself</option>
    </select>
  // Each kind of agent works differently, so the first time one is chosen its
  // guide is put in front of the user until they confirm they have read it.
  const introduce = hosts.length > 0 && !!DESTINATION_GUIDE[guideId] && !seen.includes(guideId)
  return <div className="ambio-inbox__delivery">
    <div className="ambio-inbox__delivery-heading"><label htmlFor="ambio-delivery-select" className="ambio-inbox__delivery-title">{fixed ? 'Agent' : 'Deliver to'}</label>
      <DestinationGuidePopover name={name} guideId={guideId} picker={picker('Agent to read about')} /></div>
    {picker('Work-order destination', 'ambio-delivery-select')}
    {!fixed && connected.length === 0 && onManageConnections && <small>No agent is set up with Ambio yet. <button type="button" className="ambio-inbox__delivery-link" onClick={onManageConnections}>Connect one</button></small>}
    {introduce && <DestinationIntroduction name={name} guideId={guideId} picker={picker('Agent to read about')} onConfirm={() => setSeen(markGuideSeen(guideId))} />}
  </div>
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
        <p><span className="ambio-guide__info-mark"><InboxIcon name="info" size={14} /></span>To read this again, press the info button next to Deliver to in the agent panel.</p>
        <button type="button" className="ambio-guide__confirm" autoFocus onClick={onConfirm}>Got it</button>
      </footer>
    </section>
  </div>, document.body)
}

/** How many of a run's latest events the turn shows while it works. */
const ACTIVITY_SHOWN = 6

export function AgentDeliveryStatus({ run, hosts, events = [], answered = false, onStop }: {
  run?: DeliveryRun; hosts: DeliveryHost[]; events?: DeliveryEvent[]; answered?: boolean; onStop: (run: DeliveryRun) => void
}) {
  if (!run) return null
  const working = run.state === 'running' || run.state === 'starting'
  // Once the agent has answered, its reply is the record; the play-by-play
  // stays in the output file. An error is kept, because it explains a turn
  // that never got an answer.
  const shown = answered ? [] : working ? events.slice(-ACTIVITY_SHOWN) : events.filter(event => event.kind === 'error').slice(-2)
  return <div className="ambio-inbox__delivery-run" role="status">
    <span><strong>{hosts.find(host => host.id === run.hostId)?.label ?? run.hostId}</strong> · {run.detail}{run.resumed && working ? ' Continuing its earlier session.' : ''}</span>
    {shown.length > 0 && <ol className="ambio-inbox__activity" aria-label="What the agent is doing">
      {events.length > shown.length && working && <li className="ambio-inbox__activity-earlier">{events.length - shown.length} earlier</li>}
      {shown.map((event, index) => <li key={`${event.at}:${index}`} data-kind={event.kind}>{event.text}</li>)}
    </ol>}
    {(run.state === 'running' || run.state === 'starting') && <button type="button" onClick={() => onStop(run)}>Stop run</button>}
    <button type="button" onClick={() => window.ambio.showInFolder(run.logPath)}>Show agent output</button>
  </div>
}
