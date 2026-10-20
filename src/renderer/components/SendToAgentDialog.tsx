import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore, refreshInbox, cancelInboxMessage } from '../store/sheetStore'
import { canvasReference, referenceTarget, messageReferences, inboxStatus, workOrderHandoff, WORK_ORDER_STAGES, WORK_ORDER_MODES, workOrderNote, type WorkOrderMode, type WorkOrderStage, conversations, conversationStageCounts, needsReview, requestText, turnRequest } from './inboxModel'
import { SheetComparison } from './SheetComparison'
import { InboxIcon } from './InboxIcon'
import { InboxSheetPicker } from './InboxSheetPicker'
import { AgentMessageContent } from './AgentMessageContent'
import { usePresence } from './ui/usePresence'
import { WorkOrderReview } from './WorkOrderReview'
import { AgentDeliveryDestination, AgentDeliveryStatus, DeliveryReadiness, deliveryAction, runWorking, useAgentDelivery, WorkPlaceToggle } from './AgentDelivery'
import { useCheckoutStore } from '../store/checkoutStore'
import { focusedCheckout } from './checkoutModel'
import { CHAT_DELIVERY, WATCHING_DELIVERY, deliveryReadiness, type ModelOption } from '../../shared/agentDelivery'
import { chatModels } from '../../shared/agentChat'
import { AgentModelMenu, useAgentModel } from './AgentModelMenu'
import { decideAgentPermission, refreshAgentPermissions, useAgentPermissionStore, type AgentPermissionRequest } from '../store/agentPermissionStore'
import { WorkOrderCodeChecks } from './WorkOrderCodeChecks'
import { ChatTranscript, chatAgentLabel, chatThreadId, OPEN_MODEL_SERVICES, useAgentChat } from './AgentChatPanel'
import '../styles/inbox.css'

export function SendToAgentDialog({ isOpen, onClose, onManageConnections }: { isOpen: boolean; onClose: () => void; onManageConnections?: () => void }) {
  const graph = useGraphStore(useShallow(s => ({ workspaceId: s.currentProject?.id ?? '', rootPath: s.currentProject?.rootPath ?? '', name: s.currentProject?.name, files: s.files, systems: s.systems, infra: s.infraNodes })))
  const sheet = useSheetStore(useShallow(s => ({ sheets: s.sheets, activeSheetId: s.activeSheetId, layers: s.layersById, selected: s.selectedCanvasIds, messages: s.messages, error: s.inboxError, next: s.inboxNextCursor, send: s.sendToAgent })))
  const draftKey = `ambio:inbox-draft:${graph.workspaceId}`
  const pendingKey = `${draftKey}:pending`
  const delivery = useAgentDelivery(graph.workspaceId, isOpen, graph.rootPath)
  // Questions from started agents; a project that opens mid-question still shows it.
  const permissions = useAgentPermissionStore(state => state.requests)
  useEffect(() => { void refreshAgentPermissions(graph.workspaceId) }, [graph.workspaceId, isOpen])
  const presence = usePresence(isOpen)
  const [width, setWidth] = useState(() => { try { return Number(localStorage.getItem('ambio:inbox-width')) || 0 } catch { return 0 } })
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const clamp = (value: number) => Math.round(Math.min(Math.max(value, 360), Math.max(360, window.innerWidth * 0.8)))
    const move = (moved: PointerEvent) => setWidth(clamp(window.innerWidth - moved.clientX))
    const done = (ended: PointerEvent) => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done)
      try { localStorage.setItem('ambio:inbox-width', String(clamp(window.innerWidth - ended.clientX))) } catch { /* kept for this session */ }
    }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done)
  }
  // The open panel covers the map's right edge; the map's area ends where the
  // panel begins, so every fit, search and selection centres in what is visible.
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = panelRef.current
    const style = document.documentElement.style
    if (!isOpen || !panel) { style.removeProperty('--agent-panel-inset'); return }
    const publish = () => style.setProperty('--agent-panel-inset', `${panel.offsetWidth}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(panel)
    return () => { observer.disconnect(); style.removeProperty('--agent-panel-inset') }
  }, [isOpen, presence.mounted])
  const deliveryHost = delivery.hosts.find(host => host.id === delivery.hostId)
  // A worktree of its own needs a repository with a commit to start from.
  const canWorktree = useCheckoutStore(state => {
    const head = focusedCheckout(state.snapshot)?.headState
    return head === 'commit' || head === 'detached'
  })
  const [note, setNote] = useState(() => { try { return localStorage.getItem(draftKey) ?? '' } catch { return '' } })
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState('')
  // The conversation on screen: undefined follows the most recent one, null is
  // a new conversation that has no turn yet.
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined)
  const [mode, setMode] = useState<WorkOrderMode>('build')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [excluded, setExcluded] = useState<string[]>([])
  // Files Ambio re-checks against the map after the reply (make the code match).
  const [codeFitFileIds, setCodeFitFileIds] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const attachmentArea = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const olderAnchor = useRef<{ height: number; top: number } | null>(null)
  const [attachedSheetId, setAttachedSheetId] = useState<string | null>(() => { try { const saved = JSON.parse(localStorage.getItem(`${draftKey}:sheet`) ?? 'null'); return typeof saved === 'string' ? saved : null } catch { return null } })
  const attachmentChosen = useRef((() => { try { return localStorage.getItem(`${draftKey}:sheet`) !== null } catch { return false } })())
  const sendLock = useRef(false)
  const retry = useRef<{ id: string; note: string; selection: string[]; sheetId: string | null; hostId?: string; codeFitFileIds?: string[]; threadId?: string; mode?: WorkOrderMode; model?: string }>(undefined)
  const restored = useRef(false)
  if (!restored.current) {
    restored.current = true
    try {
      const saved = JSON.parse(localStorage.getItem(pendingKey) ?? 'null')
      if (saved && typeof saved.id === 'string' && typeof saved.note === 'string' && Array.isArray(saved.selection)) retry.current = saved
    } catch { /* no pending send */ }
  }
  const { fitView, getNode } = useReactFlow()
  // Ambio's own agent is one kind of conversation here; the open one is
  // passed in once the list says which conversations are its.
  const [chatActiveId, setChatActiveId] = useState<string | null>(null)
  const chat = useAgentChat(graph.workspaceId, isOpen, chatActiveId)
  const locked = sending || !!retry.current || chat.busy
  const dismissPicker = () => { setPickerOpen(false); textarea.current?.focus() }
  const latest = () => { if (history.current) history.current.scrollTop = history.current.scrollHeight; nearBottom.current = true; setUnseen(false) }

  const attachSheet = (id: string | null) => {
    attachmentChosen.current = true
    setAttachedSheetId(id)
    try { localStorage.setItem(`${draftKey}:sheet`, JSON.stringify(id)) } catch { /* in-memory draft still works */ }
  }
  useEffect(() => {
    const attach = (event: Event) => {
      const detail = (event as CustomEvent<{ sheetId?: string; note?: string; codeFitFileIds?: string[] }>).detail
      if (retry.current || sendLock.current) return
      if (detail?.sheetId) attachSheet(detail.sheetId)
      // A gesture that needs the code to change arrives with its instruction
      // written (docs/PRODUCT.md §2); a draft already here is kept above it.
      const drafted = detail?.note
      if (drafted) setNote(current => current.trim() ? `${current.trimEnd()}\n\n${drafted}` : drafted)
      const checks = detail?.codeFitFileIds
      if (checks?.length) setCodeFitFileIds(current => [...new Set([...current, ...checks])])
    }
    window.addEventListener('ambio:open-agent-dispatch', attach)
    return () => window.removeEventListener('ambio:open-agent-dispatch', attach)
  }, [draftKey])
  useEffect(() => {
    if (isOpen && !attachmentChosen.current && !attachedSheetId) {
      const active = useSheetStore.getState().activeSheetId
      if (active) attachSheet(active)
    }
    if (isOpen) { nearBottom.current = true; latest(); textarea.current?.focus({ preventScroll: true }) }
    else setPickerOpen(false)
  }, [isOpen])
  useEffect(() => { setExcluded([]) }, [sheet.selected.join('\0')])
  useEffect(() => { try { localStorage.setItem(draftKey, note) } catch { /* drafting still works */ } }, [draftKey, note])
  useEffect(() => {
    if (!isOpen) return
    void refreshInbox(graph.workspaceId)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (pickerOpen) { setPickerOpen(false); textarea.current?.focus() }
      else onClose()
    }
    const outside = (event: PointerEvent) => {
      if (!attachmentArea.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('keydown', escape)
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside) }
  }, [isOpen, graph.workspaceId, onClose, pickerOpen])
  const allThreads = conversations(sheet.messages)
  // A built-in conversation's builds share its thread; they are shown inside it.
  const threads = allThreads.filter(thread => !thread.id.startsWith('chat:'))
  const entries: ConversationEntry[] = [
    ...threads.map(thread => ({ id: thread.id, title: thread.title, lastAt: thread.lastAt, stage: thread.stage, detail: `${thread.turns.length === 1 ? '1 turn' : `${thread.turns.length} turns`} · ${WORK_ORDER_STAGES.find(item => item.stage === thread.stage)?.label ?? ''}` })),
    ...chat.conversations.map(conversation => {
      const builds = allThreads.find(thread => thread.id === chatThreadId(conversation.id))
      const stage: WorkOrderStage | undefined = ['working', 'waiting'].includes(conversation.state) ? 'working' : builds?.stage
      return { id: conversation.id, title: requestText(conversation.title), lastAt: Math.max(conversation.updatedAt, builds?.lastAt ?? 0), stage, detail: `Ambio chat${stage ? ` · ${WORK_ORDER_STAGES.find(item => item.stage === stage)?.label}` : ''}`, chat: true }
    }),
  ].sort((a, b) => b.lastAt - a.lastAt)
  // An unconfirmed send stays in the conversation it was written in.
  const currentThreadId = retry.current?.threadId ?? (threadId === undefined ? entries[0]?.id ?? null : threadId)
  const current = threads.find(thread => thread.id === currentThreadId)
  const chatCurrent = chat.conversations.find(conversation => conversation.id === currentThreadId)
  useEffect(() => { setChatActiveId(chatCurrent?.id ?? null) }, [chatCurrent?.id])
  const shown = current?.turns ?? []
  // A new conversation can start with Ambio chat; one already under way keeps its agent.
  const chatProviderId = !chatCurrent && delivery.hostId.startsWith(`${CHAT_DELIVERY}:`) ? delivery.hostId.slice(CHAT_DELIVERY.length + 1) : ''
  const chatProvider = chat.providers.find(item => item.id === (chatCurrent?.providerId ?? chatProviderId))
  const toChat = !!chatCurrent || (!current && !!chatProvider)
  // The model menu offers what the agent this message goes to can use.
  const runHost = !toChat && deliveryHost?.route === 'run' && !delivery.watchingHosts.includes(deliveryHost.id) ? deliveryHost : undefined
  const agentModel = useAgentModel({
    key: toChat ? (chatProvider ? `chat:${chatProvider.id}` : '') : runHost?.id ?? '',
    hostId: runHost?.id,
    chatOptions: toChat && chatProvider ? chatModels(chatProvider).map((id): ModelOption => ({ id, label: id })) : undefined,
    current: chatCurrent?.model,
  })
  const chatVersion = chat.snapshot ? `${chat.snapshot.conversation.state}:${chat.snapshot.approvals.length}:${chat.snapshot.questions.length}:${chat.snapshot.messages.map(message => `${message.id}:${message.parts.map(part => `${part.text.length}${part.state ?? ''}`).join(',')}`).join('|')}` : ''
  const messageVersion = shown.map(message => `${message.id}:${message.status}:${message.reply?.createdAt ?? ''}:${message.review?.id ?? ''}:${message.sessions?.map(session => `${session.id}:${session.endedAt}:${session.notes.length}`).join(',') ?? ''}`).join('|')
  useLayoutEffect(() => {
    const el = history.current
    if (!el) return
    if (olderAnchor.current) { el.scrollTop = olderAnchor.current.top + el.scrollHeight - olderAnchor.current.height; olderAnchor.current = null }
    else if (nearBottom.current) latest()
    else setUnseen(true)
  }, [isOpen, messageVersion, chatVersion])
  // Opening another conversation starts at its latest turn.
  useLayoutEffect(() => { latest() }, [currentThreadId])
  useLayoutEffect(() => {
    const el = textarea.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px` }
  }, [isOpen, note, sending])

  if (!presence.mounted) return null
  const effectiveSheetId = retry.current ? retry.current.sheetId : attachedSheetId
  const latestRun = (messageId: string) => delivery.runs.filter(run => run.messageId === messageId).sort((a, b) => b.startedAt - a.startedAt)[0]
  const attachedSheet = sheet.sheets.find(item => item.id === effectiveSheetId)
  const planned = Object.values(sheet.layers).flatMap(layer => layer.planned)
  const selection = sheet.selected.flatMap(id => {
    const file = graph.files.find(item => item.id === id)
    if (file) return [canvasReference('file', file.id, file.relPath)]
    const system = graph.systems.find(item => item.id === id)
    if (system) return [canvasReference('system', system.id, system.name)]
    const infra = graph.infra.find(item => item.id === id)
    if (infra) return [canvasReference('infra', infra.id, infra.name)]
    const plan = planned.find(item => `planned:${item.id}` === id)
    return plan ? [canvasReference('planned', plan.id, plan.name)] : []
  }).filter(ref => !excluded.includes(ref))
  const effectiveSelection = retry.current?.selection ?? selection
  const focus = (ref: string) => {
    const target = referenceTarget(ref)
    if (!getNode(target.id)) { setError('This item is no longer visible. Open its original sheet or expand its system.'); return }
    useGraphStore.getState().setSelectedNode(target.id)
    useGraphStore.getState().setInspectedNode(target.id)
    void fitView({ nodes: [{ id: target.id }], duration: 300, maxZoom: 1.2, padding: 0.5 })
  }
  const chips = (refs: string[], editable = false) => refs.length > 0 && <div className="ambio-inbox__targets">{refs.map(ref => <button type="button" key={ref} disabled={editable && locked} onClick={() => editable ? setExcluded(current => [...current, ref]) : focus(ref)} title={editable ? `Remove ${referenceTarget(ref).label} from message` : 'Show on canvas'}>
    <InboxIcon name="canvas" size={12} /><span>{referenceTarget(ref).label}</span>{editable && !locked && <InboxIcon name="close" size={11} />}
  </button>)}</div>
  const copy = (text: string, id: string) => { void navigator.clipboard.writeText(text).then(() => setCopied(id), () => setError('Clipboard unavailable. Select the visible work order ID and tell your agent to call get_inbox with that messageId.')) }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (sendLock.current || !(retry.current?.note ?? note).trim() || effectiveSelection.length > 100) return
    if (!retry.current && attachedSheetId && !attachedSheet) { setError('This attached sheet is no longer available. Remove it before sending.'); return }
    if (toChat) {
      // Ambio chat streams its turn here; a Build still becomes a reviewable work order.
      if (chat.running) return
      const id = await chat.send({ conversationId: chatCurrent?.id ?? null, providerId: chatProvider?.id ?? '', text: note.trim(), mode, selection, sheetId: attachedSheetId, codeFitFileIds, model: agentModel.value || undefined })
      if (id) { setNote(''); setCodeFitFileIds([]); nearBottom.current = true; setThreadId(id); setChatActiveId(id) }
      requestAnimationFrame(() => textarea.current?.focus())
      return
    }
    sendLock.current = true; setSending(true); setError(null); setPickerOpen(false)
    for (const stale of shown) if ((stale.status === 'queued' || stale.status === 'delivered') && latestRun(stale.id) && !runWorking(latestRun(stale.id))) await cancelInboxMessage(graph.workspaceId, stale.id).catch(() => {})
    if (!retry.current) {
      const id = crypto.randomUUID()
      retry.current = { id, note: workOrderNote(mode, note.trim()), selection, sheetId: attachedSheetId, hostId: delivery.hostId, codeFitFileIds, threadId: currentThreadId ?? id, mode, model: agentModel.value || undefined }
    }
    try { localStorage.setItem(pendingKey, JSON.stringify(retry.current)) } catch { /* in-memory retries still work */ }
    try {
      const pending = retry.current
      // A session the user told to watch takes the turn in its own chat: any
      // watching session, or the one belonging to the chosen host.
      const watchingHost = pending.hostId && delivery.watchingHosts.includes(pending.hostId) ? pending.hostId : undefined
      const watching = pending.hostId === WATCHING_DELIVERY || !!watchingHost
      await sheet.send(graph.workspaceId, pending.note, pending.selection, pending.sheetId, pending.id, pending.codeFitFileIds, { threadId: pending.threadId, mode: pending.mode, open: watching, targetHost: watchingHost })
      if (watchingHost) delivery.setNotice(`Sent to the watching ${delivery.hosts.find(host => host.id === watchingHost)?.label ?? 'agent'} session.`)
      setNote(''); setCodeFitFileIds([]); retry.current = undefined; nearBottom.current = true
      setThreadId(pending.threadId ?? pending.id)
      try { localStorage.removeItem(pendingKey) } catch { /* already acknowledged */ }
      if (pending.hostId && !watching) await delivery.deliver(pending.id, pending.hostId, pending.model)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status && status >= 400 && status < 500) {
        retry.current = undefined
        try { localStorage.removeItem(pendingKey) } catch { /* retry remains editable */ }
      }
      setError(err instanceof Error ? err.message : 'Could not send. Your draft is saved; retry when connected.')
    }
    finally { sendLock.current = false; setSending(false); requestAnimationFrame(() => textarea.current?.focus()) }
  }
  const sendLabel = toChat ? 'Send to Ambio chat' : deliveryAction(deliveryHost, delivery.hostId, delivery.watchingHosts)
  // A turn in progress holds the message box: agents cannot take a second
  // message mid-turn, so the box says what is happening and Send becomes Stop.
  const openTurn = [...shown].reverse().find(message => message.status === 'queued' || message.status === 'delivered')
  const openRun = openTurn ? latestRun(openTurn.id) : undefined
  // A send still waiting to be confirmed is that same turn, and stays editable for its retry.
  const inProgress = toChat ? chat.running : !retry.current && !!openTurn && (runWorking(openRun) || !openRun)
  const workingLabel = toChat ? 'Ambio chat' : openRun ? delivery.hosts.find(host => host.id === openRun.hostId)?.label ?? 'The agent' : ''
  const stopTurn = async () => {
    if (toChat) { await chat.stop(); return }
    if (!openTurn) return
    if (openRun && runWorking(openRun)) await delivery.stop(openRun)
    await cancelInboxMessage(graph.workspaceId, openTurn.id).catch(err => setError(String(err)))
  }
  return <aside ref={panelRef} className="ambio-inbox nodrag nowheel" aria-label="Agent inbox" data-closing={presence.closing || undefined} style={width ? { '--inbox-width': `${width}px` } as React.CSSProperties : undefined}>
    <div className="ambio-inbox__resize" role="separator" aria-orientation="vertical" aria-label="Resize the agent panel" title="Drag to resize" onPointerDown={resize}
      onDoubleClick={() => { setWidth(0); try { localStorage.removeItem('ambio:inbox-width') } catch { /* nothing kept */ } }} />
    <header className="ambio-inbox__header"><span className="ambio-inbox__brand"><InboxIcon name="agent" size={18} /></span>
      <ConversationMenu entries={entries} currentId={currentThreadId} project={graph.name ?? ''} disabled={locked} onOpen={id => { setThreadId(id); textarea.current?.focus() }} />
      <button type="button" className="ambio-inbox__icon" disabled={locked || currentThreadId === null} onClick={() => { setThreadId(null); textarea.current?.focus() }} aria-label="New conversation" title="Start a new conversation"><InboxIcon name="plus" /></button>
      <button type="button" className="ambio-inbox__icon" onClick={onClose} aria-label="Close agent inbox"><InboxIcon name="close" /></button>
    </header>
    {(error || sheet.error || chat.error) && <div role="alert" className="ambio-inbox__error"><span>{error || sheet.error || chat.error}</span><button type="button" onClick={() => { setError(null); chat.setError(''); void refreshInbox(graph.workspaceId) }}>Refresh</button></div>}
    <div className="ambio-inbox__thread">
      <div ref={history} className={`ambio-inbox__history${shown.length ? ' ambio-inbox__history--messages' : ''}`} aria-label="Messages" onScroll={() => { const el = history.current!; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; if (nearBottom.current) setUnseen(false) }}>
        {!chatCurrent && sheet.next && <button className="ambio-inbox__earlier" type="button" disabled={loadingEarlier} onClick={() => {
          const el = history.current!; olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop }; setLoadingEarlier(true)
          void refreshInbox(graph.workspaceId, sheet.next).finally(() => { olderAnchor.current = null; setLoadingEarlier(false) })
        }}>{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button>}
        {chatCurrent && <ChatTranscript chat={chat} workspaceId={graph.workspaceId} workOrders={sheet.messages} agentLabel={chatAgentLabel(chatProvider, chatCurrent.model)} />}
        {shown.length === 0 && !chat.snapshot?.messages.length && <div className="ambio-inbox__empty"><h3>{threads.length ? 'New conversation' : 'Talk to your agent'}</h3><p>Ask a question, ask for a plan, or ask for a change. Follow-ups stay in this conversation, so the agent keeps what was said.</p></div>}
        {shown.map(message => <article key={`${graph.workspaceId}:${message.id}`} className="ambio-inbox__message">
          <div className="ambio-inbox__user"><span className="ambio-inbox__entry-label">YOU<span className="ambio-inbox__turn-mode" data-mode={turnRequest(message).mode}>{WORK_ORDER_MODES.find(item => item.mode === turnRequest(message).mode)?.label}</span>{message.status === 'answered' && needsReview(message) && <span className="ambio-inbox__turn-state" data-state={message.review?.decision === 'accepted' ? 'accepted' : 'review'}>{inboxStatus(message)}</span>}<time title={new Date(message.createdAt).toLocaleString()} dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></span><p>{turnRequest(message).text}</p>{chips(messageReferences(message.selection))}
            {message.sheetId && <button type="button" className="ambio-inbox__message-sheet" disabled={locked} onClick={() => attachSheet(message.sheetId)} title="Attach the current sheet to a new message"><InboxIcon name="sheet" size={14} /><span>{message.sentSheetName || sheet.sheets.find(item => item.id === message.sheetId)?.name || 'Attached sheet'}{message.sentSheetRevision ? ` · sent r${message.sentSheetRevision}` : ''}</span><InboxIcon name="chevron" size={12} /></button>}
          </div>
          {(message.status === 'queued' || message.status === 'delivered') && (run => run
            ? <AgentDeliveryStatus run={run} hosts={delivery.hosts} events={delivery.events[run.key]} onRetry={runWorking(run) ? undefined : () => { void delivery.deliver(message.id, run.hostId, agentModel.value || undefined) }} />
            // Nothing Ambio started: the turn waits for an agent outside it, which takes the handoff.
            : <div className="ambio-inbox__turn-status" data-state="waiting" role="status">
              <p><span className="ambio-inbox__turn-pulse" aria-hidden="true" />{inboxStatus(message)}.</p>
              <div className="ambio-inbox__turn-actions"><button type="button" className="ambio-inbox__turn-action" onClick={() => copy(workOrderHandoff(graph.name ?? 'this project', graph.workspaceId, graph.rootPath, message.id), `handoff:${message.id}`)}><InboxIcon name={copied === `handoff:${message.id}` ? 'check' : 'copy'} size={12} />{copied === `handoff:${message.id}` ? 'Copied' : 'Copy handoff'}</button></div>
            </div>)(latestRun(message.id))}
          {permissions.filter(request => request.messageId === message.id).map(request => <PermissionCard key={request.id} request={request} hostLabel={delivery.hosts.find(host => host.id === request.hostId)?.label} />)}
          {message.status !== 'answered' && !latestRun(message.id) && message.sessions?.filter(session => !session.endedAt).slice(-1).map(session => <section key={session.id} className="ambio-inbox__progress" aria-label={`Work progress: ${session.goal}`}><strong>{session.agent || 'Agent'} · {session.goal}</strong>{session.notes.length > 0 && <p>{session.notes.at(-1)?.text}</p>}</section>)}
          {message.reply && <div className="ambio-inbox__reply"><div className="ambio-inbox__reply-heading"><InboxIcon name="agent" size={16} /><strong>{message.reply.agent}</strong><button type="button" className="ambio-inbox__copy-reply" aria-label={copied === message.id ? 'Reply copied' : 'Copy reply'} onClick={() => copy(message.reply!.body, message.id)}><InboxIcon name={copied === message.id ? 'check' : 'copy'} size={13} />{copied === message.id ? 'Copied' : 'Copy'}</button></div><AgentMessageContent text={message.reply.body} /></div>}
          {message.status === 'answered' && !message.reply && <p className="ambio-inbox__notice">This older reply is no longer available.</p>}
          {message.status === 'cancelled' && <p className="ambio-inbox__turn-status" data-state="stopped">Cancelled</p>}
          {/* Only a build changed anything; a question or a proposal has nothing to accept here. */}
          {needsReview(message) && message.codeChecks && message.codeChecks.length > 0 && <WorkOrderCodeChecks checks={message.codeChecks} />}
          {needsReview(message) && <WorkOrderReview message={message} workspaceId={graph.workspaceId} currentSheet={sheet.sheets.find(item => item.id === message.sheetId)} />}
        </article>)}
        {/* A question that names no turn on screen is still a question. */}
        {permissions.filter(request => !shown.some(message => message.id === request.messageId)).map(request => <PermissionCard key={request.id} request={request} hostLabel={delivery.hosts.find(host => host.id === request.hostId)?.label} />)}
      </div>
      {unseen && <button className="ambio-inbox__latest" type="button" onClick={latest}>Jump to latest ↓</button>}
    </div>
    <div className="ambio-inbox__bottom">
      {(readiness => readiness.tone === 'ready' || readiness.tone === 'neutral' ? null : <DeliveryReadiness onFix={onManageConnections} readiness={readiness} />)(deliveryReadiness({ hostId: retry.current?.hostId ?? delivery.hostId, hosts: delivery.hosts, installedIds: delivery.installedIds, watchers: delivery.watchers, watchingHosts: delivery.watchingHosts,
        chat: toChat ? { service: chatProvider?.name ?? 'this service', keyMissing: !!chatProvider && !chatProvider.hasKey && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(chatProvider.baseUrl) } : undefined }))}
      {effectiveSheetId && attachedSheet && <SheetComparison key={effectiveSheetId} workspaceId={graph.workspaceId} sheetId={effectiveSheetId} />}
      <form className="ambio-inbox__compose" onSubmit={submit}>
        {delivery.notice && <p className="ambio-inbox__notice" role="status">{delivery.notice}</p>}
        {(effectiveSheetId || effectiveSelection.length > 0 || codeFitFileIds.length > 0) && <div className="ambio-inbox__attachments">
          {codeFitFileIds.length > 0 && <div className="ambio-inbox__attachment" title="After the agent replies, Ambio checks that the code agrees with where the map puts these files"><span className="ambio-inbox__sheet-icon"><InboxIcon name="check" size={16} /></span><span><strong>Ambio checks the code afterwards</strong><small>{codeFitFileIds.length === 1 ? '1 file' : `${codeFitFileIds.length} files`}</small></span><button className="ambio-inbox__icon" type="button" disabled={locked} aria-label="Don't check the code afterwards" onClick={() => setCodeFitFileIds([])}><InboxIcon name="close" size={13} /></button></div>}
          {effectiveSheetId && <div className="ambio-inbox__attachment" title={attachedSheet ? `${attachedSheet.name} · revision ${attachedSheet.revision} · snapshot and structural comparison included` : 'This sheet is no longer available'}><span className="ambio-inbox__sheet-icon"><InboxIcon name="sheet" size={16} /></span><span><strong>{attachedSheet?.name ?? 'Sheet unavailable'}</strong><small>{attachedSheet?.resolvedAt ? 'Resolved sheet' : attachedSheet ? 'Sheet' : 'Remove attachment'}</small></span><button className="ambio-inbox__icon" type="button" disabled={locked} aria-label="Remove attached sheet" onClick={() => attachSheet(null)}><InboxIcon name="close" size={13} /></button></div>}
          {chips(effectiveSelection, true)}
        </div>}
        <textarea ref={textarea} id="ambio-inbox-note" aria-label="Instruction for your agent" value={inProgress ? '' : retry.current?.note ?? note} disabled={locked || inProgress} onChange={event => setNote(event.target.value)} maxLength={16000} rows={2} placeholder={inProgress ? (workingLabel ? `${workingLabel} is working on your request…` : 'Waiting for your agent to pick up your request…') : shown.length || chat.snapshot?.messages.length ? 'Reply, or ask for the next step…' : 'Describe a change or ask a question…'} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
          if (event.key === '@' && (event.currentTarget.selectionStart === 0 || /\s/.test(note[event.currentTarget.selectionStart - 1]))) { event.preventDefault(); setPickerOpen(true) }
        }} />
        <div className="ambio-inbox__compose-tools"><div ref={attachmentArea} className="ambio-inbox__attach-anchor">
          <button type="button" className="ambio-inbox__icon" disabled={locked} aria-label="Attach context" aria-haspopup="dialog" aria-expanded={pickerOpen} title="Attach a sheet (@)" onClick={() => setPickerOpen(!pickerOpen)}><InboxIcon name="attach" size={19} /></button>
          {pickerOpen && <InboxSheetPicker sheets={sheet.sheets} attachedId={effectiveSheetId} onClose={dismissPicker} onSelect={id => { attachSheet(id); dismissPicker() }} />}
        </div><AgentDeliveryDestination hosts={delivery.hosts} hostId={retry.current?.hostId ?? (delivery.hostId.startsWith(`${CHAT_DELIVERY}:`) && !chatProvider ? '' : delivery.hostId)} installedIds={delivery.installedIds} watchers={delivery.watchers} watchingHosts={delivery.watchingHosts} onChange={delivery.setHostId} disabled={locked || !!delivery.busy || inProgress} rootPath={graph.rootPath} onManageConnections={onManageConnections}
          chatServices={current ? undefined : chat.providers.map(provider => ({ id: provider.id, label: chatAgentLabel(provider, provider.model) }))}
          onSetUpChat={() => window.dispatchEvent(new Event(OPEN_MODEL_SERVICES))}
          fixed={chatCurrent ? { label: chatAgentLabel(chatProvider, chatCurrent.model), guideId: CHAT_DELIVERY } : undefined}>
          <AgentModelMenu model={agentModel} disabled={locked || inProgress} />
          {deliveryHost?.route === 'run' && canWorktree && !chatCurrent && <WorkPlaceToggle where={delivery.where} onChange={delivery.setWhere} disabled={locked || inProgress} />}
        </AgentDeliveryDestination><span>{retry.current && !sending ? 'Send unconfirmed · retry' : sending || chat.busy ? 'Sending…' : ''}</span><WorkOrderModeMenu mode={mode} disabled={locked || inProgress} onChange={value => { setMode(value); textarea.current?.focus() }} />{inProgress
          ? <button className="ambio-inbox__send ambio-inbox__stop" type="button" aria-label="Stop" title="Stop this request" disabled={chat.busy} onClick={() => { void stopTurn() }}><InboxIcon name="stop" size={15} /></button>
          : <button className="ambio-inbox__send" type="submit" aria-label={sendLabel} title={retry.current ? 'Retry original message' : sendLabel} disabled={sending || !!delivery.busy || chat.busy || !(retry.current?.note ?? note).trim() || effectiveSelection.length > 100}><InboxIcon name={retry.current && !sending ? 'retry' : 'send'} size={19} /></button>}</div>
      </form>
      {effectiveSelection.length > 100 && <small className="ambio-inbox__limit" role="alert">Attach up to 100 canvas items per message.</small>}
    </div>
  </aside>
}

/** An agent is stopped on a question; the answer is one press. */
function PermissionCard({ request, hostLabel }: { request: AgentPermissionRequest; hostLabel?: string }) {
  return <section className="ambio-inbox__permission" role="group" aria-label={`Permission request: ${request.title}`}>
    <strong>{hostLabel ?? 'The agent'} is asking: {request.title}</strong>
    {request.detail && <code>{request.detail}</code>}
    <div>
      <button type="button" className="ambio-inbox__permission-allow" onClick={() => { void decideAgentPermission(request, 'allow') }}>Allow</button>
      <button type="button" onClick={() => { void decideAgentPermission(request, 'deny') }}>Don&rsquo;t allow</button>
      <small>It waits for your answer; no answer is a no.</small>
    </div>
  </section>
}

/** One row of the conversation menu: a work-order thread, or an Ambio chat conversation. */
interface ConversationEntry { id: string; title: string; lastAt: number; stage?: WorkOrderStage; detail: string; chat?: boolean }

/** The open conversation's name, which opens the list of the others. */
function ConversationMenu({ entries, currentId, project, disabled, onOpen }: {
  entries: ConversationEntry[]; currentId: string | null; project: string; disabled: boolean; onOpen: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // Which conversations the menu lists: all of them, or the ones at one stage.
  const [stage, setStage] = useState<WorkOrderStage | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const current = entries.find(entry => entry.id === currentId)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const staged = entries.filter((entry): entry is ConversationEntry & { stage: WorkOrderStage } => !!entry.stage)
  const counts = conversationStageCounts(staged)
  // Answers waiting for a verdict in conversations that are not on screen.
  const toReview = staged.filter(entry => entry.stage === 'review' && entry.id !== currentId).length
  const listed = stage ? entries.filter(entry => entry.stage === stage) : entries
  return <div ref={anchor} className="ambio-inbox__heading ambio-inbox__conversations" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-inbox__conversation-button" disabled={disabled || entries.length === 0} aria-haspopup="menu" aria-expanded={open}
      aria-label={`Conversation: ${current?.title ?? 'New conversation'}`} title={entries.length > 1 ? 'Open another conversation' : undefined} onClick={() => setOpen(!open)}>
      <h2>{current?.title ?? 'New conversation'}</h2>
      <span title={project}>{project}{entries.length > 1 ? ` · ${entries.length} conversations` : ''}{toReview > 0 ? ` · ${toReview} to review` : ''}</span>
      {entries.length > 0 && <InboxIcon name="chevron" size={11} />}
    </button>
    {open && <div className="ambio-inbox__conversation-menu" role="menu" aria-label="Conversations">
      {entries.length > 1 && <div className="ambio-inbox__stages" role="group" aria-label="Show conversations">
        <button type="button" aria-pressed={stage === null} onClick={() => setStage(null)}>All <span>{entries.length}</span></button>
        {WORK_ORDER_STAGES.filter(item => counts[item.stage] > 0 || stage === item.stage).map(item =>
          <button key={item.stage} type="button" aria-pressed={stage === item.stage} onClick={() => setStage(stage === item.stage ? null : item.stage)}>
            {item.label} <span>{counts[item.stage]}</span>
          </button>)}
      </div>}
      {listed.length === 0 && <p className="ambio-inbox__notice">No conversations are {WORK_ORDER_STAGES.find(item => item.stage === stage)?.label.toLowerCase()}.</p>}
      {listed.map(entry => <button key={entry.id} type="button" role="menuitemradio" aria-checked={entry.id === currentId} autoFocus={entry.id === currentId}
        onClick={() => { onOpen(entry.id); setOpen(false) }}>
        <strong>{entry.title}</strong>
        <small>{entry.detail} · {new Date(entry.lastAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
      </button>)}
    </div>}
  </div>
}

/** What is being asked for, as one button beside Send that opens the choices. */
function WorkOrderModeMenu({ mode, disabled, onChange }: { mode: WorkOrderMode; disabled: boolean; onChange: (mode: WorkOrderMode) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const current = WORK_ORDER_MODES.find(item => item.mode === mode) ?? WORK_ORDER_MODES[0]
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={anchor} className="ambio-inbox__mode" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }}>
    <button type="button" className="ambio-inbox__mode-button" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={`Request type: ${current.label}`} title={current.hint} onClick={() => setOpen(!open)}>
      {current.label}<InboxIcon name="chevron" size={11} />
    </button>
    {open && <div className="ambio-inbox__mode-menu" role="menu" aria-label="What you are asking for">
      {WORK_ORDER_MODES.map(item => <button key={item.mode} type="button" role="menuitemradio" aria-checked={mode === item.mode} aria-label={item.label}
        autoFocus={mode === item.mode} onClick={() => { onChange(item.mode); setOpen(false) }}>
        <strong>{item.label}</strong><small>{item.hint}</small>{mode === item.mode && <InboxIcon name="check" size={13} />}
      </button>)}
    </div>}
  </div>
}
