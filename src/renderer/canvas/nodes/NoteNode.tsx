import { memo, useState } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import type { SheetAnnotation } from '../../store/sheetStore'
import type { NodeResizeParams } from '../resizeGeometry'
import { AmbioNodeResizer } from './AmbioNodeResizer'

export interface NoteNodeData extends Record<string, unknown> {
  note: SheetAnnotation
  editable: boolean
  deleted: boolean
  geometrySaving: boolean
  geometryError?: string
  initialDraft?: { body: string; revision: number }
  onDraft: (draft: { body: string; revision: number } | null) => void
  onSave: (body: string, revision: number) => Promise<void>
  onDelete: () => Promise<void>
  onBeginGeometry: () => void
  onFinishGeometry: (geometry: NodeResizeParams) => void
}

function NoteNode({ id, data, selected, width, height }: NodeProps<Node<NoteNodeData>>) {
  const [editing, setEditing] = useState(!!data.initialDraft)
  const [draft, setDraft] = useState(data.initialDraft?.body ?? data.note.body)
  const [revision, setRevision] = useState(data.initialDraft?.revision ?? data.note.revision)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const changed = editing && revision !== data.note.revision
  const begin = () => {
    if (!data.editable) return
    const next = { body: data.note.body, revision: data.note.revision }
    setDraft(next.body); setRevision(next.revision); setEditing(true); setError(''); data.onDraft(next)
  }
  const cancel = () => { setEditing(false); setError(''); data.onDraft(null) }
  const save = async (expected = revision) => {
    if (!draft.trim() || saving) return
    setSaving(true); setError('')
    try { await data.onSave(draft, expected); setEditing(false); data.onDraft(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this note.') }
    finally { setSaving(false) }
  }
  const remove = async () => {
    setSaving(true); setError('')
    try { await data.onDelete(); data.onDraft(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete this note.') }
    finally { setSaving(false) }
  }
  return <>
    <AmbioNodeResizer nodeId={id} isVisible={!!selected && data.editable && !saving && !data.geometrySaving}
      presentationScale={1} nodeWidth={width} nodeHeight={height} color="#9a782d"
      minWidth={160} minHeight={100} maxWidth={2000} maxHeight={2000}
      onResizeStart={data.onBeginGeometry} onResizeEnd={data.onFinishGeometry} />
    <article className={`canvas-note${editing ? ' canvas-note--editing' : ''}`} aria-label="Sticky note"
      tabIndex={0} onDoubleClick={event => { event.stopPropagation(); if (!editing) begin() }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !data.editable) return
        if (event.key === 'Enter') { event.preventDefault(); begin() }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); void remove() }
      }}>
      <header className="canvas-note__header">
        <span>NOTE <span className="canvas-note__author">{data.note.author === 'agent' ? 'Agent' : 'You'}</span></span>
        {data.editable && <span className="canvas-note__actions nodrag nopan">
          {!editing && <button title="Edit note" aria-label="Edit note" disabled={saving} onClick={begin}>Edit</button>}
          <button title="Delete note" aria-label="Delete note" disabled={saving || data.deleted} onClick={() => void remove()}>×</button>
        </span>}
      </header>
      {editing && data.editable ? <>
        <textarea className="canvas-note__editor nodrag nopan nowheel" aria-label="Note text" autoFocus value={draft} maxLength={100000}
          onChange={event => { setDraft(event.target.value); data.onDraft({ body: event.target.value, revision }) }}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Escape') { event.preventDefault(); cancel() }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
          }} />
        <footer className="canvas-note__footer nodrag nopan">
          <button disabled={saving || !draft.trim()} onClick={() => void save()}>{saving ? 'Saving…' : data.deleted ? 'Save as new note' : 'Save'}</button>
          <button disabled={saving} onClick={cancel}>Cancel</button>
        </footer>
      </> : <div className="canvas-note__body nodrag nopan">{editing ? draft : data.note.body}</div>}
      {(changed || data.deleted || error || data.geometryError) && <div className="canvas-note__notice nodrag nopan" role="status">
        {data.deleted ? 'This note was deleted. Your draft is kept.' : error || data.geometryError || 'This note has a newer edit. Your draft is kept.'}
        {changed && !data.deleted && editing && <span className="canvas-note__conflict-actions">
          <button disabled={saving} onClick={() => {
            setDraft(data.note.body); setRevision(data.note.revision); setError('')
            data.onDraft({ body: data.note.body, revision: data.note.revision })
          }}>Use latest text</button>
          <button disabled={saving || !draft.trim()} onClick={() => void save(data.note.revision)}>Save my draft instead</button>
        </span>}
      </div>}
    </article>
  </>
}

export default memo(NoteNode)
