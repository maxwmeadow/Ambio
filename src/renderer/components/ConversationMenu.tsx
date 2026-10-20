import { useEffect, useRef, useState } from 'react'
import { conversationStageCounts, WORK_ORDER_STAGES, type WorkOrderStage } from './inboxModel'
import { InboxIcon } from './InboxIcon'

export interface ConversationEntry {
  id: string; title: string; lastAt: number; stage?: WorkOrderStage; detail: string
  chat?: boolean; replyAt: number; active: boolean; unread?: boolean
}

export function ConversationMenu({ entries, currentId, project, disabled, onOpen, onRename, onDelete }: {
  entries: ConversationEntry[]; currentId: string | null; project: string; disabled: boolean
  onOpen: (id: string) => void; onRename: (id: string, title: string) => void; onDelete: (id: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<WorkOrderStage | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [actions, setActions] = useState<string | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const current = entries.find(entry => entry.id === currentId)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) { setOpen(false); setEditing(null); setDeleting(null); setActions(null) } }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const counts = conversationStageCounts(entries.filter((entry): entry is ConversationEntry & { stage: WorkOrderStage } => !!entry.stage))
  const unread = entries.filter(entry => entry.unread && entry.id !== currentId).length
  const listed = stage ? entries.filter(entry => entry.stage === stage) : entries
  return <div ref={anchor} className="ambio-inbox__heading ambio-inbox__conversations" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); setOpen(false); setEditing(null); setDeleting(null); setActions(null) }
  }}>
    <button type="button" className="ambio-inbox__conversation-button" disabled={disabled || entries.length === 0} aria-haspopup="menu" aria-expanded={open}
      aria-label={`Conversation: ${current?.title ?? 'New conversation'}`} title="Open conversations" onClick={() => { setOpen(!open); setActions(null) }}>
      <h2>{current?.title ?? 'New conversation'}</h2>
      <span>{project}{unread > 0 ? ` — ${unread} new ${unread === 1 ? 'reply' : 'replies'}` : ''}</span>
      {entries.length > 0 && <InboxIcon name="chevron" size={11} />}
    </button>
    {open && <div className="ambio-inbox__conversation-menu" role="menu" aria-label="Conversations">
      <details className="ambio-inbox__conversation-filters"><summary>Filter conversations</summary>
        <div className="ambio-inbox__stages" role="group" aria-label="Show conversations">
          <button type="button" aria-pressed={stage === null} onClick={() => setStage(null)}>All <span>{entries.length}</span></button>
          {WORK_ORDER_STAGES.filter(item => counts[item.stage] > 0 || stage === item.stage).map(item => <button key={item.stage} type="button" aria-pressed={stage === item.stage} onClick={() => setStage(stage === item.stage ? null : item.stage)}>{item.label} <span>{counts[item.stage]}</span></button>)}
        </div>
      </details>
      {failure && <p role="alert">{failure}</p>}
      {listed.length === 0 && <p className="ambio-inbox__notice">No conversations to show.</p>}
      {listed.map(entry => <div className="ambio-inbox__conversation-row" key={entry.id}>
        {editing === entry.id ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) { onRename(entry.id, title.trim()); setEditing(null) } }}>
          <input autoFocus aria-label="Conversation name" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
          <button type="submit" disabled={!title.trim()}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button>
        </form> : <>
          <button className="ambio-inbox__conversation-entry" type="button" role="menuitemradio" aria-checked={entry.id === currentId}
            onClick={() => { onOpen(entry.id); setOpen(false); setActions(null) }} title={entry.title}>
            <strong>{entry.title}</strong>
            <time title={new Date(entry.lastAt).toLocaleString()}>{new Date(entry.lastAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
            {(entry.unread || entry.stage === 'review' || entry.active) && <small data-attention={entry.unread || entry.stage === 'review' || undefined}>{entry.unread && <span>New reply</span>}{entry.stage === 'review' && <span>Needs review</span>}{entry.active && <span>{entry.detail || 'Working'}</span>}</small>}
          </button>
          <details className="ambio-inbox__conversation-actions" open={actions === entry.id}><summary aria-label={`Actions for ${entry.title}`} onClick={event => { event.preventDefault(); setActions(actions === entry.id ? null : entry.id) }}>⋯</summary>
            <button type="button" disabled={disabled || busy} onClick={() => { setTitle(entry.title); setEditing(entry.id); setDeleting(null); setActions(null) }}>Rename</button>
            <button type="button" disabled={disabled || busy || entry.active} title={entry.active ? 'Stop this conversation before deleting it' : undefined} onClick={() => { setDeleting(entry.id); setFailure(''); setActions(null) }}>Delete conversation</button>
          </details>
        </>}
        {deleting === entry.id && <div className="ambio-inbox__conversation-delete"><p>Delete this conversation? Its messages will be removed. Sheets and code are kept.</p>
          <button type="button" disabled={busy} onClick={() => { setBusy(true); void onDelete(entry.id).then(() => setDeleting(null), error => setFailure(String(error))).finally(() => setBusy(false)) }}>{busy ? 'Deleting…' : 'Delete'}</button>
          <button type="button" disabled={busy} onClick={() => setDeleting(null)}>Keep conversation</button>
        </div>}
      </div>)}
    </div>}
  </div>
}
