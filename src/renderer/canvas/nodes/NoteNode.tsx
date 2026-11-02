import { memo, useEffect, useSyncExternalStore } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import type { SheetAnnotation } from '../../store/sheetStore'
import type { NodeResizeParams } from '../resizeGeometry'
import type { NoteAutosave } from '../noteAutosave'
import { AmbioNodeResizer } from './AmbioNodeResizer'

export interface NoteNodeData extends Record<string, unknown> {
  note: SheetAnnotation
  editor: NoteAutosave
  editable: boolean
  deleted: boolean
  geometrySaving: boolean
  geometryError?: string
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onDelete: () => Promise<void>
}

function NoteNode({ id, data, selected, width, height }: NodeProps<Node<NoteNodeData>>) {
  const editor = data.editor
  const text = useSyncExternalStore(editor.subscribe, editor.getSnapshot)
  const worldScale = Number(data.worldScale) || 1
  useEffect(() => { editor.receive(data.note, data.deleted, data.editable) }, [editor, data.note, data.deleted, data.editable])
  useEffect(() => { if (!data.editable && text.editing) editor.end() }, [editor, data.editable, text.editing])
  useEffect(() => () => editor.end(), [editor])
  return <>
    <AmbioNodeResizer nodeId={id} isVisible={!!selected && data.editable && !text.saving && !data.deleted}
      presentationScale={worldScale} nodeWidth={width} nodeHeight={height} color="#9a782d"
      minWidth={160 * worldScale} minHeight={100 * worldScale} maxWidth={2000 * worldScale} maxHeight={2000 * worldScale}
      onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
    <article className={`canvas-note${text.editing ? ' canvas-note--editing' : ''}`} aria-label="Sticky note" aria-busy={text.saving}
      style={{ width: `${100 / worldScale}%`, height: `${100 / worldScale}%`, transform: `scale(${worldScale})`, transformOrigin: 'top left' }}
      tabIndex={0} onDoubleClick={event => { event.stopPropagation(); if (data.editable && !text.editing) editor.begin() }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !data.editable) return
        if (event.key === 'Enter') { event.preventDefault(); editor.begin() }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); void editor.remove() }
      }}>
      <header className="canvas-note__header"><span>NOTE <span className="canvas-note__author">{data.note.author === 'agent' ? 'Agent' : 'You'}</span></span></header>
      {text.editing && data.editable ? <textarea className="canvas-note__editor nodrag nopan nowheel" aria-label="Note text" autoFocus value={text.body} maxLength={100000}
        onChange={event => editor.change(event.target.value)} onBlur={() => editor.end()}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
            event.preventDefault(); event.currentTarget.blur(); editor.end()
          }
        }} /> : <div className="canvas-note__body nodrag nopan">{text.body}</div>}
      {(text.conflict || data.deleted || text.error || data.geometryError) && <div className="canvas-note__notice nodrag nopan" role="status">
        {data.deleted ? 'This note was deleted. Your text is kept.' : text.error || data.geometryError || 'This note has a newer edit. Your text is kept.'}
        {data.editable && <span className="canvas-note__conflict-actions">
          {data.deleted ? <button disabled={text.saving} onMouseDown={event => event.preventDefault()} onClick={() => void editor.keepMine()}>Restore note</button>
            : text.conflict ? <>
              <button disabled={text.saving} onMouseDown={event => event.preventDefault()} onClick={() => editor.useLatest()}>Use latest text</button>
              <button disabled={text.saving} onMouseDown={event => event.preventDefault()} onClick={() => void editor.keepMine()}>Keep my text</button>
            </> : text.error && <button disabled={text.saving} onMouseDown={event => event.preventDefault()} onClick={() => void editor.retry()}>Retry</button>}
        </span>}
      </div>}
    </article>
  </>
}
export default memo(NoteNode)
