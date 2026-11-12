import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_DELIVERY, DESTINATION_GUIDE, WATCHING_DELIVERY, type DeliveryReadinessResult, chooseDeliveryHost, type AgentAccess, type DeliveryEvent, type DeliveryHost, type DeliveryRequest, type DeliveryRun } from '../../shared/agentDelivery'
import { archdApi } from '../archdEndpoint.ts'
import { InboxIcon } from './InboxIcon'
import { rememberDeliveryHost, rememberedDeliveryHost } from '../projectLocalState'
import { AgentAccessChoices, type AgentAccessChoice } from './AgentAccess'
import { idSaysMore, modelChoices, modelLabel, thinkingChoices, thinkingLabel, type AgentModelChoice } from './AgentModelMenu'

export function useAgentDelivery(workspaceId: string, isOpen: boolean, rootPath?: string) {
  const [hosts, setHosts] = useState<DeliveryHost[]>([])
  const [hostId, setHostIdState] = useState('')
  const [installedIds, setInstalledIds] = useState<string[]>([])
  // Apps whose settings name Ambio's server, whatever else is set up there:
  // all a CLI that reads its tools from that app needs (RUN_NEEDS_INSTALL).
  const [configuredIds, setConfiguredIds] = useState<string[]>([])
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
  // Whether a new conversation's Build gets a worktree of its own
  // (GIT_AND_PROJECT_SHAPES stage 4), remembered per project; registered in
  // projectLocalState.
  const [where, setWhereState] = useState<'here' | 'worktree'>('here')
  useEffect(() => {
    try { setWhereState(localStorage.getItem(`delivery_where_${workspaceId}`) === 'worktree' ? 'worktree' : 'here') } catch { setWhereState('here') }
  }, [workspaceId])
  const setWhere = (next: 'here' | 'worktree') => {
    setWhereState(next)
    try { localStorage.setItem(`delivery_where_${workspaceId}`, next) } catch { /* this window only, then */ }
  }
  const lock = useRef(false)
  const workspace = useRef(workspaceId)
  workspace.current = workspaceId
  // Another project's agents are not this one's: until this project's are read,
  // there are none, so no agent's introduction shows for a choice not yet made.
  useEffect(() => { chosen.current = false; setHosts([]); setHostIdState(''); setInstalledIds([]); setConfiguredIds([]); setRuns([]); setEvents({}); seen.current = {}; setNotice('') }, [workspaceId])
  useEffect(() => {
    if (!isOpen) return
    let active = true
    // Start on an agent that can receive the request: the one used last here,
    // else one connected now, else one Ambio is installed in.
    const agentHosts = Promise.resolve().then(() => window.ambio.listAgentHosts(rootPath)).catch(() => [])
    const installed = agentHosts.then(items => items.filter(item => item.configured && item.workflowInstalled).map(item => item.id))
    const configured = agentHosts.then(items => items.filter(item => item.configured).map(item => item.id))
    const live = fetch(`${archdApi()}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
      .then(response => response.ok ? response.json() as Promise<{ connections?: Array<{ hostId: string }> }> : {})
      .then(body => (body as { connections?: Array<{ hostId: string }> }).connections?.map(item => item.hostId) ?? [], () => [] as string[])
    const watching = () => fetch(`${archdApi()}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
      .then(response => response.ok ? response.json() as Promise<{ connections?: Array<{ hostId: string; watchingUntil?: number }> }> : {})
      .then(body => ((body as { connections?: Array<{ hostId: string; watchingUntil?: number }> }).connections ?? []).filter(item => (item.watchingUntil ?? 0) > Date.now()).map(item => item.hostId), () => [] as string[])
    // Codex's levels can arrive after the first read; until then the list is
    // read again with each poll (each read looks for every agent's CLI).
    let hostsPending = true
    void window.ambio.listDeliveryHosts().then(async items => {
      hostsPending = items.some(item => item.accessPending)
      const [installedNow, configuredNow, liveNow, watchingNow] = await Promise.all([installed, configured, live, watching()])
      if (!active) return
      setHosts(items)
      setInstalledIds([...new Set([...liveNow, ...installedNow])])
      setConfiguredIds(configuredNow)
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
        if (hostsPending) {
          const hostsNow = await window.ambio.listDeliveryHosts()
          hostsPending = hostsNow.some(item => item.accessPending)
          // The first read sets the agents together with the one to start on;
          // setting them here first would show "Copy the handoff myself" (and
          // its introduction) for a moment before that choice lands.
          if (active) setHosts(current => current.length === 0 || JSON.stringify(current) === JSON.stringify(hostsNow) ? current : hostsNow)
        }
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
          if (!known || JSON.stringify(known) !== JSON.stringify(fresh) || !working) { seen.current = { ...seen.current, [run.key]: next }; setEvents(seen.current) }
        }
      } catch { if (active) setNotice('Agent run status unavailable. Check the host before sending again.') }
      const watchingNow = await watching()
      if (active) setWatchingHosts(current => current.length === watchingNow.length && current.every((host, index) => host === watchingNow[index]) ? current : watchingNow)
      if (active) timer = setTimeout(() => { void refresh() }, live ? 1000 : 3000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [workspaceId, isOpen, rootPath])
  // `place` is the turn's own: only a conversation's first Build can ask for a worktree.
  const deliver = async (messageId: string, destination = hostId, model?: string, place: 'here' | 'worktree' = 'here', options: { thinking?: string; access?: AgentAccess } & Pick<DeliveryRequest, 'codexTransport' | 'codexReview' | 'command'> = {}) => {
    if (!destination || lock.current) return
    lock.current = true; setBusy(messageId)
    try {
      const result = await window.ambio.deliverWorkOrder({ workspaceId, messageId, hostId: destination, ...(model ? { model } : {}), ...options, where: place })
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
  return { hosts, hostId, setHostId, installedIds, configuredIds, runs, events, watchers, watchingHosts, notice, setNotice, busy, deliver, stop, where, setWhere }
}

export function deliveryAction(host?: DeliveryHost, hostId = '', watchingHosts: string[] = []): string {
  if (hostId.startsWith(CHAT_DELIVERY)) return 'Send to Ambio chat'
  if (hostId === WATCHING_DELIVERY) return 'Send to watching session'
  if (host && watchingHosts.includes(host.id)) return `Send to the watching ${host.label} session`
  if (!host) return 'Send to inbox'
  return host.route === 'run' ? `Start ${host.label}` : host.route === 'open' ? `Copy + open ${host.label}` : `Copy for ${host.label}`
}

export function AgentDeliveryDestination({ hosts, hostId, installedIds, watchers = 0, watchingHosts = [], onChange, disabled, rootPath, onManageConnections, chatServices, onSetUpChat, onNewConversation, fixed, access, model, modelDisabled }: {
  hosts: DeliveryHost[]; hostId: string; installedIds: string[]; watchers?: number; watchingHosts?: string[]; onChange: (value: string) => void; disabled: boolean; rootPath: string
  onManageConnections?: () => void
  /** Ambio chat's model services; undefined hides Ambio chat. */
  chatServices?: { id: string; label: string }[]
  onSetUpChat?: () => void
  /** Set while another client's conversation is open: Ambio chat cannot continue it, so choosing chat starts a new one. */
  onNewConversation?: () => void
  /** The agent an open conversation is bound to, shown instead of the picker. */
  fixed?: { label: string; guideId: string }
  /** The level the chosen agent's next turn would run at; its guide asks for one while none is chosen. */
  access?: AgentAccessChoice
  /** The chosen agent's model and thinking level, chosen in the same control. */
  model?: AgentModelChoice
  modelDisabled?: boolean
}) {
  const [seen, setSeen] = useState(seenGuides)
  // The agent whose guide was opened from the menu's info button or the fixed agent's name.
  const [reading, setReading] = useState<string | null>(null)
  const isChat = (value: string) => value.startsWith(CHAT_DELIVERY)
  const guideOf = (value: string) => fixed?.guideId ?? (isChat(value) ? CHAT_DELIVERY : value === WATCHING_DELIVERY || watchingHosts.includes(value) ? WATCHING_DELIVERY : value)
  const nameOf = (value: string) => fixed?.label ?? (isChat(value) ? chatServices?.find(service => `${CHAT_DELIVERY}:${service.id}` === value)?.label ?? 'Ambio chat'
    : value === WATCHING_DELIVERY ? 'Session watching Ambio' : hosts.find(item => item.id === value)?.label ?? 'Copy the handoff myself')
  // Only an agent Ambio starts itself runs at a level Ambio sets; a watching session keeps its app's own.
  const accessHostOf = (value: string) => {
    const host = hosts.find(item => item.id === value)
    return !fixed && host?.route === 'run' && !watchingHosts.includes(host.id) && host.access?.length ? host : undefined
  }
  const choose = (value: string) => {
    if (value === CHAT_DELIVERY) { onSetUpChat?.(); return }
    if (isChat(value)) onNewConversation?.()
    onChange(value)
  }
  // A host with a session watching gets the message in that session.
  const state = (item: DeliveryHost) => watchingHosts.includes(item.id) ? 'Attached' : item.route !== 'run' && !installedIds.includes(item.id) ? 'Ambio not added' : undefined
  const choice = (item: DeliveryHost): AgentChoice => ({ value: item.id, label: item.label, detail: state(item), disabled: !item.available })
  const started = hosts.filter(item => item.route === 'run' && item.available)
  const inApps = hosts.filter(item => item.route !== 'run')
  const missing = hosts.filter(item => item.route === 'run' && !item.available)
  // The picker, the guides it opens and the first-use introduction are one
  // choice: changing any of them changes the destination.
  const groups: AgentChoiceGroup[] = [
    ...(chatServices ? [{ label: 'Built into Ambio', items: chatServices.length
      ? chatServices.map(service => ({ value: `${CHAT_DELIVERY}:${service.id}`, label: service.label, ...(onNewConversation ? { detail: 'Starts a new conversation' } : {}) }))
      : [{ value: CHAT_DELIVERY, label: 'Ambio chat', detail: 'Set up a model service first' }] }] : []),
    { label: 'Ambio runs it for you', items: started.map(choice) },
    { label: 'Opens in your app', items: inApps.map(choice) },
    { label: 'Not found on this computer', items: missing.map(choice) },
    // A session told to watch keeps its own conversation; offered while one is waiting, or when it was the choice.
    { items: [
      ...((watchers > 0 || hostId === WATCHING_DELIVERY) ? [{ value: WATCHING_DELIVERY, label: 'Session watching Ambio', detail: watchers > 1 ? `${watchers} sessions` : watchers === 1 ? undefined : 'None right now' }] : []),
      { value: '', label: 'Copy the handoff myself' },
    ] },
  ].map(group => ({ ...group, items: group.items.map(item => ({ ...item, info: !!DESTINATION_GUIDE[guideOf(item.value)] })) }))
  const fixedField = fixed && <p className="ambio-inbox__delivery-fixed">{fixed.label}<small>Start a new conversation to use another agent.</small></p>
  const guidePicker = (value: string, onPick: (value: string) => void) => fixedField
    || <AgentMenu label="Agent to read about" value={value} groups={groups} variant="field" onChange={onPick} />
  const guideId = guideOf(hostId)
  // Each kind of agent works differently, so the first time one is chosen its
  // guide is put in front of the user until they confirm they have read it,
  // and again while an agent Ambio runs has no access level chosen.
  const needsIntroduction = hosts.length > 0 && ((!!DESTINATION_GUIDE[guideId] && !seen.includes(guideId)) || !!access?.needsChoice)
  // Once up, it stays until confirmed: choosing a level inside it must not close it.
  const [introduced, setIntroduced] = useState<string | null>(null)
  useEffect(() => { if (needsIntroduction) setIntroduced(hostId) }, [needsIntroduction, hostId])
  const introduce = needsIntroduction || introduced === hostId
  // One control in the message box's row: the agent, its model and thinking level.
  return <div className="ambio-inbox__agent-picker">
    <AgentSetupMenu value={hostId} groups={groups} disabled={disabled} onChange={choose} onInfo={setReading}
      fixed={fixed ? { label: fixed.label, onAbout: () => setReading(fixed.guideId) } : undefined} model={model} modelDisabled={modelDisabled} />
    {introduce
      ? <DestinationGuide name={nameOf(hostId)} guideId={guideId} accessHost={accessHostOf(hostId)} picker={guidePicker(hostId, choose)}
        intro={{ ready: !access?.needsChoice, onConfirm: () => { setSeen(markGuideSeen(guideId)); setIntroduced(null) } }} />
      : reading !== null && <DestinationGuide name={nameOf(reading)} guideId={guideOf(reading)} accessHost={accessHostOf(reading)} picker={guidePicker(reading, setReading)}
        onClose={() => setReading(null)} onUse={!fixed && reading !== hostId ? () => { setSeen(markGuideSeen(guideOf(reading))); setReading(null); choose(reading) } : undefined} />}
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

/** info: the agent has a guide, opened from the row's info button. */
export interface AgentChoice { value: string; label: string; detail?: string; disabled?: boolean; info?: boolean }
export interface AgentChoiceGroup { label?: string; items: AgentChoice[] }

/**
 * Choosing an agent, in Ambio's own menu like the model and request type:
 * agents grouped by how they run, a short state under each, and the current
 * one checked. Hovering a row shows its info button, which opens that agent's
 * guide. Used in the message box and in the agent guides.
 */
function AgentMenu({ label, value, groups, onChange, onInfo, disabled, variant }: {
  label: string; value: string; groups: AgentChoiceGroup[]; onChange: (value: string) => void; disabled?: boolean
  onInfo?: (value: string) => void
  /** segment: part of the message box's agent pill; field: a full-width control in a guide. */
  variant: 'segment' | 'field'
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const current = groups.flatMap(group => group.items).find(item => item.value === value)
  return <div ref={anchor} className={`ambio-agent-menu ambio-agent-menu--${variant}`} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-agent-menu__trigger" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={`${label}: ${current?.label ?? 'none'}`} data-value={value} onClick={() => setOpen(!open)}>
      <span>{current?.label ?? 'Choose an agent'}</span>
      <InboxIcon name="chevron" size={11} />
    </button>
    {open && <AgentChoiceList className="ambio-agent-menu__list" label={label} value={value} groups={groups}
      onPick={item => { onChange(item); setOpen(false) }} onInfo={onInfo ? item => { setOpen(false); onInfo(item) } : undefined} />}
  </div>
}

/** The agents, grouped by how they run, each with its state and its guide's info button. */
function AgentChoiceList({ className, label, value, groups, onPick, onInfo }: {
  className: string; label: string; value: string; groups: AgentChoiceGroup[]
  onPick: (value: string) => void; onInfo?: (value: string) => void
}) {
  return <div className={className} role="menu" aria-label={label}>
    {groups.filter(group => group.items.length).map((group, index) => <div key={group.label ?? index} role="group" aria-label={group.label}>
      {group.label && <div className="ambio-agent-menu__heading">{group.label}</div>}
      {group.items.map(item => <div key={item.value || 'manual'} className="ambio-agent-menu__row">
        <button type="button" role="menuitemradio" aria-checked={item.value === value} data-value={item.value}
          disabled={item.disabled} autoFocus={item.value === value} onClick={() => onPick(item.value)}>
          <strong>{item.label}</strong>
          {item.detail && <small>{item.detail}</small>}
          {item.value === value && <InboxIcon name="check" size={13} />}
        </button>
        {onInfo && item.info && <button type="button" className="ambio-agent-menu__info" aria-label={`About ${item.label}`} title={`How ${item.label} works here`}
          onClick={() => onInfo(item.value)}><InboxIcon name="info" size={13} /></button>}
      </div>)}
    </div>)}
  </div>
}

/** In the composer the menu's group already says how an agent runs, so "CLI" and the like are left off. */
const shortAgentName = (label: string) => label.replace(/\s+(\(CLI\)|\(IDE\)|CLI|IDE)$/, '')

/**
 * The message box's one control for who does the work: the client, its model
 * and its thinking level. Closed, it names the model and level (or the client,
 * while the model is the client's own). Open, it lists the three as rows; the
 * client and model rows each open their full list in place, with a way back, so
 * nothing is squeezed whatever the panel's width. Choosing anything keeps it
 * open where the choice was made, with the new one checked.
 */
function AgentSetupMenu({ value, groups, disabled, onChange, onInfo, fixed, model, modelDisabled }: {
  value: string; groups: AgentChoiceGroup[]; disabled: boolean
  onChange: (value: string) => void; onInfo: (value: string) => void
  /** A conversation keeps its client: the client row names it and opens its guide. */
  fixed?: { label: string; onAbout: () => void }
  model?: AgentModelChoice; modelDisabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'agents' | 'models'>('main')
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const agent = fixed?.label ?? groups.flatMap(group => group.items).find(item => item.value === value)?.label ?? 'Choose an agent'
  const offersModels = !!model && (model.loading || model.options.length > 0)
  const chosenModel = model && model.value ? modelLabel(model) : undefined
  const levels = model ? thinkingChoices(model) : []
  const thinking = model ? thinkingLabel(model) : undefined
  const summary = [agent, chosenModel ?? (offersModels ? 'default model' : undefined), thinking && `${thinking} thinking`].filter(Boolean).join(', ')
  const close = () => { setOpen(false); setView('main') }
  return <div ref={anchor} className="ambio-agent-setup" onKeyDown={event => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation()
    if (view === 'main') close(); else setView('main')
  }}>
    <button type="button" className="ambio-agent-setup__trigger" disabled={disabled && !fixed} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Client and model: ${summary}`} title={summary} data-value={value} onClick={() => { if (open) close(); else { setView('main'); setOpen(true) } }}>
      <InboxIcon name="agent" size={13} />
      <span className="ambio-agent-setup__primary">{chosenModel ?? shortAgentName(agent)}</span>
      {thinking && <span className="ambio-agent-setup__secondary">{thinking}</span>}
      <InboxIcon name="chevron" size={11} />
    </button>
    {open && <div className="ambio-agent-setup__panel" role="dialog" aria-label="Client and model">
      {view === 'main' && <div className="ambio-agent-setup__rows">
        {fixed
          ? <button type="button" className="ambio-agent-setup__row" aria-label={`Client: ${fixed.label}`} title="How this client works here. Start a new conversation to use another client." onClick={() => { close(); fixed.onAbout() }}>
            <span className="ambio-agent-setup__label">Client</span>
            <span className="ambio-agent-setup__value"><strong className="ambio-inbox__delivery-fixed">{fixed.label}</strong><small>Kept for this conversation</small></span>
            <InboxIcon name="info" size={13} />
          </button>
          : <button type="button" className="ambio-agent-setup__row" aria-label={`Client: ${agent}`} disabled={disabled} onClick={() => setView('agents')}>
            <span className="ambio-agent-setup__label">Client</span>
            <span className="ambio-agent-setup__value"><strong>{agent}</strong></span>
            <InboxIcon name="chevron" size={12} />
          </button>}
        {model && <button type="button" className="ambio-agent-setup__row" aria-label={`Model: ${model.loading ? 'loading' : offersModels ? modelLabel(model) : 'set by the agent'}`}
          disabled={modelDisabled || !offersModels || model.loading} onClick={() => setView('models')}>
          <span className="ambio-agent-setup__label">Model</span>
          <span className="ambio-agent-setup__value"><strong>{model.loading ? 'Loading models…' : offersModels ? modelLabel(model) : 'Set by the agent'}</strong>
            {!model.loading && !offersModels && <small>This agent chooses its model in its own app</small>}</span>
          {offersModels && !model.loading && <InboxIcon name="chevron" size={12} />}
        </button>}
        {levels.length > 0 && <div className="ambio-agent-setup__thinking" role="group" aria-label="Thinking">
          <span className="ambio-agent-setup__label">Thinking</span>
          <div className="ambio-agent-setup__levels">
            {levels.map(level => <button key={level.id || 'default'} type="button" role="menuitemradio" aria-checked={(model!.thinking ?? '') === level.id} aria-label={`Thinking: ${level.label}`}
              disabled={modelDisabled} onClick={() => model!.setThinking?.(level.id)}>{level.label}</button>)}
          </div>
        </div>}
      </div>}
      {view !== 'main' && <button type="button" className="ambio-agent-setup__back" onClick={() => setView('main')}>
        <InboxIcon name="chevron" size={12} />{view === 'agents' ? 'Client' : 'Model'}
      </button>}
      {view === 'agents' && <AgentChoiceList className="ambio-agent-menu__list ambio-agent-setup__list" label="Work-order destination" value={value} groups={groups}
        onPick={onChange} onInfo={item => { close(); onInfo(item) }} />}
      {view === 'models' && model && <div className="ambio-agent-menu__list ambio-agent-setup__list" role="menu" aria-label="Model">
        {modelChoices(model).map(option => <button key={option.id || 'default'} type="button" role="menuitemradio" aria-checked={model.value === option.id} aria-label={option.label}
          autoFocus={model.value === option.id} onClick={() => model.set(option.id)}>
          <strong>{option.label}</strong>{option.id && idSaysMore(option) && <small>{option.id}</small>}{!option.id && <small>Whatever the agent is set to use</small>}
          {model.value === option.id && <InboxIcon name="check" size={13} />}
        </button>)}
      </div>}
    </div>}
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
    <section><h3>What you need</h3><ul>{guide.need.map(item => <li key={item}><span aria-hidden="true"><InboxIcon name="plus" size={11} /></span>{item}</li>)}</ul></section>
    <section><h3>How it works</h3><ol>{guide.how.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span>{step}</li>)}</ol></section>
    <section><h3>What it can do</h3><ul>{guide.can.map(item => <li key={item}><span aria-hidden="true"><InboxIcon name="check" size={12} /></span>{item}</li>)}</ul></section>
  </div>
}

/**
 * An agent's guide, full screen: how it works here and, for an agent Ambio
 * runs, how much it may do without asking. The first time an agent is chosen
 * (intro) only confirming closes it, and confirming waits for an access level;
 * opened again from the agent menu it closes freely, and can choose the agent
 * it describes. The picker inside reads about, or chooses, another agent.
 */
function DestinationGuide({ name, guideId, accessHost, picker, intro, onClose, onUse }: {
  name: string; guideId: string; accessHost?: DeliveryHost; picker: ReactNode
  intro?: { ready: boolean; onConfirm: () => void }
  onClose?: () => void
  /** Reading about an agent other than the chosen one: choose it. */
  onUse?: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => { dialog.current?.focus() }, [])
  return createPortal(<div className="ambio-guide-backdrop" onPointerDown={event => { if (!intro && event.target === event.currentTarget) onClose?.() }} onKeyDown={event => {
    // Escape must not close the panel behind it; on first use, confirming is the only way past.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); if (!intro) onClose?.() }
  }}>
    <section ref={dialog} tabIndex={-1} className="ambio-guide ambio-guide--intro" role="dialog" aria-modal="true" aria-label={intro ? `Before you use ${name}` : `About ${name}`}>
      <header className="ambio-guide__header"><span className="ambio-guide__eyebrow">{intro ? 'Before you use this agent' : 'How it works here'}</span><h2>{name}</h2>
        {intro && <p>Every agent works a little differently from this panel. Here is what to expect from this one.</p>}
        {!intro && <button type="button" className="ambio-guide__close" aria-label="Close" onClick={onClose}><InboxIcon name="close" size={14} /></button>}</header>
      <div className="ambio-guide__picker"><span>Agent</span>{picker}</div>
      {accessHost && <div className="ambio-guide__access"><AgentAccessChoices host={accessHost} /></div>}
      <DestinationGuideBody guideId={guideId} />
      <footer className="ambio-guide__footer">
        {intro
          ? <><p><span className="ambio-guide__info-mark"><InboxIcon name="info" size={14} /></span>{accessHost && !intro.ready
            ? 'Choose what it may do without asking to continue. You can change it later here or in Settings → Agents.'
            : 'To read this again, hover over the agent in the agent menu and press its info button.'}</p>
            <button type="button" className="ambio-guide__confirm" disabled={!intro.ready} onClick={intro.onConfirm}>Got it</button></>
          : <><p>{accessHost ? 'What it may do without asking is also in Settings → Agents.' : ''}</p>
            <button type="button" className="ambio-guide__confirm" onClick={onUse ?? onClose}>{onUse ? `Use ${name}` : 'Done'}</button></>}
      </footer>
    </section>
  </div>, document.body)
}

/** A run that has not ended yet. */
export const runWorking = (run?: DeliveryRun) => !!run && (run.state === 'starting' || run.state === 'running' || run.state === 'stopping')
