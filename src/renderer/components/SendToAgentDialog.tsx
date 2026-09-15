import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore, refreshInbox, cancelInboxMessage } from '../store/sheetStore'
import { canvasReference, referenceTarget, messageReferences, inboxStatus } from './inboxModel'
import '../styles/inbox.css'

export function SendToAgentDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const graph = useGraphStore(useShallow(s => ({ workspaceId: s.currentProject?.id ?? '', name: s.currentProject?.name, files: s.files, systems: s.systems, infra: s.infraNodes })))
  const sheet = useSheetStore(useShallow(s => ({ activeSheetId: s.activeSheetId, layers: s.layersById, selected: s.selectedCanvasIds, messages: s.messages, error: s.inboxError, next: s.inboxNextCursor, send: s.sendToAgent })))
  const draftKey = `axiom:inbox-draft:${graph.workspaceId}`
  const pendingKey = `${draftKey}:pending`
  const [note, setNote] = useState(() => { try { return localStorage.getItem(draftKey) ?? '' } catch { return '' } })
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const sendLock = useRef(false)
  const retry = useRef<{ id: string; note: string; selection: string[]; sheetId: string | null }>(undefined)
  const restored = useRef(false)
  if (!restored.current) {
    restored.current = true
    try {
      const saved = JSON.parse(localStorage.getItem(pendingKey) ?? 'null')
      if (saved && typeof saved.id === 'string' && typeof saved.note === 'string' && Array.isArray(saved.selection)) retry.current = saved
    } catch { /* no pending send */ }
  }
  const { fitView, getNode } = useReactFlow()

  useEffect(() => { try { localStorage.setItem(draftKey, note) } catch { /* drafting still works */ } }, [draftKey, note])
  useEffect(() => {
    if (!isOpen) return
    void refreshInbox(graph.workspaceId)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [isOpen, graph.workspaceId, onClose])

  if (!isOpen) return null
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
  })
  const focus = (ref: string) => {
    const target = referenceTarget(ref)
    if (!getNode(target.id)) { setError('This item is no longer visible. Open its original sheet or expand its system.'); return }
    useGraphStore.getState().setSelectedNode(target.id)
    useGraphStore.getState().setInspectedNode(target.id)
    void fitView({ nodes: [{ id: target.id }], duration: 300, maxZoom: 1.2, padding: 0.5 })
  }
  const chips = (refs: string[]) => <div className="axiom-inbox__targets">{refs.map(ref => <button type="button" key={ref} onClick={() => focus(ref)} title="Show on canvas">{referenceTarget(ref).label}</button>)}</div>
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (sendLock.current || !(retry.current?.note ?? note).trim()) return
    sendLock.current = true; setSending(true); setError(null)
    if (!retry.current) retry.current = { id: crypto.randomUUID(), note: note.trim(), selection, sheetId: sheet.activeSheetId }
    try { localStorage.setItem(pendingKey, JSON.stringify(retry.current)) } catch { /* in-memory retries still work */ }
    try {
      const pending = retry.current
      await sheet.send(graph.workspaceId, pending.note, pending.selection, pending.sheetId, pending.id)
      setNote(''); retry.current = undefined
      try { localStorage.removeItem(pendingKey) } catch { /* already acknowledged */ }
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status && status >= 400 && status < 500) {
        retry.current = undefined
        try { localStorage.removeItem(pendingKey) } catch { /* retry remains editable */ }
      }
      setError(err instanceof Error ? err.message : 'Could not send. Your draft is saved; retry when connected.')
    }
    finally { sendLock.current = false; setSending(false) }
  }
  return <aside className="axiom-inbox nodrag nowheel" aria-label="Agent inbox">
    <header className="axiom-inbox__header"><div><h2>Agent inbox</h2><span>{graph.name}</span></div><button type="button" onClick={onClose} aria-label="Close agent inbox">×</button></header>
    <div className="axiom-inbox__instructions">
      <p>Messages wait here until an agent checks Axiom.</p>
      <button type="button" onClick={() => { void navigator.clipboard.writeText('Check the Axiom inbox for this project. Read the instruction and attached context, then reply through Axiom.').then(() => setCopied(true), () => setError('Copy this into your agent: Check the Axiom inbox for this project.')) }}>{copied ? 'Copied instruction' : 'Copy “Check the Axiom inbox”'}</button>
    </div>
    {(error || sheet.error) && <div role="alert" className="axiom-inbox__error">{error || sheet.error}<button type="button" onClick={() => { setError(null); void refreshInbox(graph.workspaceId) }}>Refresh</button></div>}
    <div className="axiom-inbox__history" aria-label="Messages">
      {sheet.messages.length === 0 && <p className="axiom-inbox__empty">Select items on the canvas and tell your agent what you want to do. You can also send a message about the whole project.</p>}
      {sheet.messages.slice().reverse().map(message => <article key={message.id} className="axiom-inbox__message">
        <div className="axiom-inbox__meta"><span>{inboxStatus(message)}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p>{message.note}</p>
        {chips(messageReferences(message.selection))}
        {message.reply && <div className="axiom-inbox__reply"><strong>{message.reply.agent}</strong><p>{message.reply.body}</p></div>}
        {message.status === 'answered' && !message.reply && <small>This older message was answered, but its original reply is no longer available.</small>}
        {(message.status === 'queued' || message.status === 'delivered') && <button className="axiom-inbox__cancel" type="button" onClick={() => { void cancelInboxMessage(graph.workspaceId, message.id).catch(err => setError(String(err))) }}>Cancel request</button>}
        {message.status === 'cancelled' && <small>Cancelled in Axiom. Tell your agent to stop if it has already started.</small>}
      </article>)}
      {sheet.next && <button type="button" onClick={() => { void refreshInbox(graph.workspaceId, sheet.next) }}>Load earlier messages</button>}
    </div>
    <form className="axiom-inbox__compose" onSubmit={submit}>
      {chips(retry.current?.selection ?? selection)}
      {retry.current && !sending && <small>A send is awaiting confirmation. Retry to check it safely; its original instruction and selection are preserved.</small>}
      {sheet.activeSheetId && <small>The active sheet’s context and approved build plan will be attached.</small>}
      <label htmlFor="axiom-inbox-note">Instruction for your agent</label>
      <textarea id="axiom-inbox-note" value={retry.current?.note ?? note} disabled={sending || !!retry.current} onChange={event => setNote(event.target.value)} maxLength={16000} rows={4} placeholder="What would you like to understand or change?" />
      <button type="submit" disabled={sending || !(retry.current?.note ?? note).trim() || (retry.current?.selection ?? selection).length > 100}>{sending ? 'Saving…' : 'Send to inbox'}</button>
    </form>
  </aside>
}
