import React from 'react'
import { createPortal } from 'react-dom'
import { unifiedMergeView } from '@codemirror/merge'
import { Compartment, EditorState, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { apiGetFileSource, apiSaveFileSource, type FileSource } from '../canvas/arcdApi'
import { useSourcePreviewStore } from '../store/sourcePreviewStore'
import { languageFor, revealLine, sourceEditorState } from './sourceEditor'

interface SourcePreviewDialogProps {
  fileId: string
  workspaceId: string
  /** A symbol (with its kind), or a plain line range someone pointed at (without). */
  symbol: { name: string; kind?: string; lineStart: number; lineEnd?: number }
  onClose: () => void
}

/** Larger files open read-only; archd refuses to save them from Ambio. */
const MAX_EDITABLE = 8 << 20

function highlightedRange(symbol: SourcePreviewDialogProps['symbol']): { start: number; end: number } {
  const start = Math.max(1, symbol.lineStart)
  const kind = symbol.kind?.toLowerCase()
  const spansDefinition = !kind || kind === 'function' || kind === 'method' || kind === 'class' ||
    kind === 'interface' || kind === 'type'
  return { start, end: spansDefinition ? Math.max(start, symbol.lineEnd ?? start) : start }
}

/** The app-wide source viewer, opened through useSourcePreviewStore. */
export function SourcePreviewHost() {
  const request = useSourcePreviewStore(state => state.request)
  const close = useSourcePreviewStore(state => state.close)
  if (!request) return null
  const { fileId, workspaceId, ...symbol } = request
  return <SourcePreviewDialog key={`${fileId}:${symbol.lineStart}:${symbol.lineEnd ?? ''}`} fileId={fileId} workspaceId={workspaceId} symbol={symbol} onClose={close} />
}

function displayError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unable to load this source file.'
  try {
    const payload = JSON.parse(error.message) as { error?: string }
    return payload.error || error.message
  } catch {
    return error.message
  }
}

type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string }

/**
 * A project file in an editor, opened at the lines someone pointed at. Edits
 * save with Ctrl+S (or Save) only over the version they were made against: if
 * an agent or another editor changed the file meanwhile, the save stops and
 * shows the differences, and the person chooses which version to keep.
 */
export function SourcePreviewDialog({ fileId, workspaceId, symbol, onClose }: SourcePreviewDialogProps) {
  const [source, setSource] = React.useState<FileSource | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [status, setStatus] = React.useState<SaveStatus>({ kind: 'idle' })
  const [conflict, setConflict] = React.useState<FileSource | null>(null)
  const [showDiff, setShowDiff] = React.useState(false)
  const [confirmClose, setConfirmClose] = React.useState(false)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  /** The version on disk the editor's text is based on. */
  const baseRef = React.useRef<{ hash: string; text: Text | null }>({ hash: '', text: null })
  const slots = React.useMemo(() => ({ language: new Compartment(), readOnly: new Compartment(), diff: new Compartment() }), [])
  const range = React.useMemo(() => highlightedRange(symbol), [symbol])
  const editable = !!source && source.editable && source.content.length <= MAX_EDITABLE

  React.useEffect(() => {
    const controller = new AbortController()
    setSource(null)
    setError(null)
    void apiGetFileSource(fileId, workspaceId, controller.signal)
      .then(setSource)
      .catch(fetchError => {
        if (!(fetchError instanceof DOMException && fetchError.name === 'AbortError')) setError(displayError(fetchError))
      })
    return () => controller.abort()
  }, [fileId, workspaceId])

  const save = React.useCallback(async (baseHash?: string): Promise<boolean> => {
    const view = viewRef.current
    if (!view || !editable) return false
    const text = view.state.doc
    // Nothing to write: Ctrl+S on an unchanged file is not a save.
    if (!baseHash && baseRef.current.text && text.eq(baseRef.current.text)) return true
    setStatus({ kind: 'saving' })
    // sliceDoc joins lines with the file's own separator; doc.toString() would turn CRLF into LF.
    const result = await apiSaveFileSource(fileId, workspaceId, view.state.sliceDoc(), baseHash ?? baseRef.current.hash)
    if (result.status === 'saved') {
      baseRef.current = { hash: result.source.hash, text }
      // Typing during the save leaves those keystrokes unsaved.
      setDirty(!view.state.doc.eq(text))
      setConflict(null)
      setShowDiff(false)
      setStatus({ kind: 'saved' })
      return true
    }
    if (result.status === 'conflict') {
      setConflict(result.current)
      setStatus({ kind: 'idle' })
      return false
    }
    setStatus({ kind: 'failed', message: result.error })
    return false
  }, [editable, fileId, workspaceId])
  const saveRef = React.useRef(save)
  saveRef.current = save

  // The editor is made once, from the version first loaded; saves keep it.
  const opened = source !== null
  React.useEffect(() => {
    const host = hostRef.current
    if (!opened || !host || !source) return
    baseRef.current = { hash: source.hash, text: null }
    const view = new EditorView({
      parent: host,
      state: sourceEditorState({
        content: source.content,
        range,
        dynamic: [
          slots.language.of([]),
          slots.readOnly.of([EditorState.readOnly.of(!editable)]),
          slots.diff.of([]),
        ],
        onSave: () => { void saveRef.current(); return true },
        onChange: state => setDirty(!state.doc.eq(baseRef.current.text!)),
      }),
    })
    baseRef.current.text = view.state.doc
    viewRef.current = view
    revealLine(view, range.start)
    let current = true
    void languageFor(source.relPath).then(language => {
      if (current && language) view.dispatch({ effects: slots.language.reconfigure(language) })
    })
    return () => {
      current = false
      view.destroy()
      viewRef.current = null
    }
    // Only a newly opened file makes a new editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: slots.diff.reconfigure(showDiff && conflict ? unifiedMergeView({ original: conflict.content, mergeControls: false, gutter: true }) : []) })
  }, [showDiff, conflict, slots])

  const requestClose = React.useCallback(() => {
    if (dirty) setConfirmClose(true)
    else onClose()
  }, [dirty, onClose])

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      // The editor's own Escape (closing search, a selection) comes first.
      if (event.key === 'Escape' && !event.defaultPrevented) requestClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [requestClose])

  const takeDiskVersion = () => {
    const view = viewRef.current
    if (!view || !conflict) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: conflict.content } })
    baseRef.current = { hash: conflict.hash, text: view.state.doc }
    setSource(conflict)
    setDirty(false)
    setConflict(null)
    setShowDiff(false)
    setStatus({ kind: 'idle' })
  }

  const title = source?.relPath ?? fileId
  const lineCount = React.useMemo(() => {
    if (!source?.content) return 0
    const lines = source.content.split(/\r\n|\n/)
    return lines.at(-1) === '' ? lines.length - 1 : lines.length
  }, [source])
  const statusText = !source ? ''
    : !source.editable ? 'read-only: not UTF-8 text'
      : !editable ? 'read-only: too large to edit here'
        : status.kind === 'saving' ? 'saving…'
          : status.kind === 'failed' ? `not saved: ${status.message}`
            : dirty ? 'modified'
              : status.kind === 'saved' ? 'saved' : ''

  return createPortal(
    <div
      className="source-preview-backdrop nodrag nopan nowheel"
      role="presentation"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) requestClose()
      }}
      onWheel={event => event.stopPropagation()}
    >
      <section className="source-preview-dialog" role="dialog" aria-modal="true" aria-label={`${symbol.name} in ${title}`}>
        <header className="source-preview-header">
          <div className="source-preview-heading">
            <div className="source-preview-path" title={title}>{title}{dirty ? ' •' : ''}</div>
            <div className="source-preview-location">
              {symbol.kind ? `${symbol.kind} ${symbol.name} · ` : ''}{range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`}
              {source && range.start > lineCount && ` · past the end of this ${lineCount}-line file; it may have changed since`}
            </div>
          </div>
          <div className="source-preview-actions">
            {statusText && <span className={`source-preview-status${status.kind === 'failed' ? ' source-preview-status-error' : ''}`} role="status">{statusText}</span>}
            {editable && <button type="button" className="source-preview-button" disabled={!dirty || status.kind === 'saving'} onClick={() => { void save() }} title="Save (Ctrl+S)">Save</button>}
            <button autoFocus className="source-preview-close" onClick={requestClose} aria-label="Close source preview">×</button>
          </div>
        </header>
        {conflict && (
          <div className="source-preview-bar" role="alert">
            <span>{conflict.relPath} changed on disk while you were editing. Nothing was saved.</span>
            <button type="button" className="source-preview-button" onClick={() => setShowDiff(shown => !shown)}>{showDiff ? 'Hide differences' : 'Show differences'}</button>
            <button type="button" className="source-preview-button" onClick={() => { void save(conflict.hash) }}>Keep mine</button>
            <button type="button" className="source-preview-button" onClick={takeDiskVersion}>Use the file on disk</button>
          </div>
        )}
        {confirmClose && (
          <div className="source-preview-bar" role="alert">
            <span>Save your changes to {title}?</span>
            <button type="button" className="source-preview-button" onClick={() => { void save().then(saved => { if (saved) onClose(); else setConfirmClose(false) }) }}>Save and close</button>
            <button type="button" className="source-preview-button" onClick={onClose}>Discard</button>
            <button type="button" className="source-preview-button" onClick={() => { setConfirmClose(false); viewRef.current?.focus() }}>Keep editing</button>
          </div>
        )}
        <div className="source-preview-code" aria-busy={!source && !error}>
          {!source && !error && <div className="source-preview-message">Loading source…</div>}
          {error && <div className="source-preview-message source-preview-error">{error}</div>}
          <div ref={hostRef} className="source-preview-editor" hidden={!source} />
        </div>
      </section>
    </div>,
    document.body,
  )
}
