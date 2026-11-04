import React from 'react'
import { createPortal } from 'react-dom'
import { unifiedMergeView } from '@codemirror/merge'
import { Compartment, EditorState, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import { selectAll } from '@codemirror/commands'
import { apiGetCommittedSource, apiGetFileSource, apiSaveFileSource, type FileSource } from '../canvas/arcdApi'
import { fetchFileSymbols } from '../canvas/symbolCache'
import { useShowOnMap } from '../canvas/useShowOnMap'
import { useGraphStore } from '../store/graphStore'
import { useSourcePreviewStore, type SourcePreviewRequest } from '../store/sourcePreviewStore'
import { ago, baselineText, chunkAt, revertSpec, setBaseline } from './sourceChanges'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { codeReference } from './inboxModel'
import { detectIndent, languageFor, languageName, nameAt, replaceWithin, revealLine, sourceEditorState } from './sourceEditor'
import { definitionInFile, enclosingSymbols, outlineField, outlineFromSymbols, setOutline, type OutlineSymbol } from './sourceOutline'
import { resolveSymbol } from './symbolLookup'

interface SourcePreviewDialogProps {
  fileId: string
  workspaceId: string
  /** A symbol (with its kind), or a plain line range someone pointed at (without). */
  symbol: { name: string; kind?: string; lineStart: number; lineEnd?: number; wholeFile?: boolean }
  onClose: () => void
}

/** Larger files open read-only; archd refuses to save them from Ambio. */
const MAX_EDITABLE = 8 << 20

/** The lines to highlight and open at; none when the file itself was opened. */
function highlightedRange(symbol: SourcePreviewDialogProps['symbol']): { start: number; end: number } | null {
  if (symbol.wholeFile) return null
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
  return <SourcePreviewDialog key={`${fileId}:${symbol.wholeFile ? 'file' : `${symbol.lineStart}:${symbol.lineEnd ?? ''}`}`} fileId={fileId} workspaceId={workspaceId} symbol={symbol} onClose={close} />
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

/** Unsaved edits, kept so a crash, reload or quit does not lose them. */
interface Draft { content: string; baseHash: string; savedAt: number }
const draftKey = (workspaceId: string, fileId: string) => `ambio.sourceDraft.${workspaceId}.${fileId}`
function readDraft(key: string): Draft | null {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null
    return draft && typeof draft.content === 'string' && typeof draft.baseHash === 'string' ? draft : null
  } catch { return null }
}
function writeDraft(key: string, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft))
    else localStorage.removeItem(key)
  } catch { /* storage full or refused: the draft lives only in the editor */ }
}

type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string }
/** The file on disk differs from what the editor is based on: found by a refused save, or by watching. */
interface Conflict { current: FileSource; onSave: boolean }

/**
 * A project file in an editor, opened at the lines someone pointed at. Edits
 * save with Ctrl+S (or Save) only over the version they were made against.
 * When an agent or another editor changes the file, an untouched editor
 * reloads it; one with edits says so at once and shows the differences.
 */
export function SourcePreviewDialog({ fileId, workspaceId, symbol, onClose }: SourcePreviewDialogProps) {
  const [source, setSource] = React.useState<FileSource | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [status, setStatus] = React.useState<SaveStatus>({ kind: 'idle' })
  const [conflict, setConflict] = React.useState<Conflict | null>(null)
  const [showDiff, setShowDiff] = React.useState(false)
  /** What to do once the person has decided about unsaved changes. */
  const [leaving, setLeaving] = React.useState<{ then: () => void } | null>(null)
  const [draftOffer, setDraftOffer] = React.useState<Draft | null>(null)
  const [notice, setNotice] = React.useState('')
  const [cursor, setCursor] = React.useState({ line: 1, column: 1, selected: 0, crumbs: [] as OutlineSymbol[] })
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  /** The version on disk the editor's text is based on. */
  const baseRef = React.useRef<{ hash: string; text: Text | null }>({ hash: '', text: null })
  const dirtyRef = React.useRef(false)
  dirtyRef.current = dirty
  const slots = React.useMemo(() => ({ language: new Compartment(), readOnly: new Compartment(), diff: new Compartment() }), [])
  const range = React.useMemo(() => highlightedRange(symbol), [symbol])
  const editable = !!source && source.editable && source.content.length <= MAX_EDITABLE
  const storageKey = draftKey(workspaceId, fileId)
  const showOnMap = useShowOnMap()
  const history = useSourcePreviewStore(state => state.history)
  const fileRecord = useGraphStore(state => state.files.find(file => file.id === fileId))
  const systemName = useGraphStore(state => fileRecord?.systemId ? state.systems.find(system => system.id === fileRecord.systemId)?.name : undefined)

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

  const say = React.useCallback((text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice(current => current === text ? '' : current), 4000)
  }, [])

  /** The comparison with the last commit, and the outline, for the text as it is now. */
  const refreshContext = React.useCallback((view: EditorView, isCurrent: () => boolean) => {
    void apiGetCommittedSource(fileId, workspaceId).then(committed => {
      if (!isCurrent() || !committed.repository) return
      const text = baselineText(committed.tracked ? committed.content : '', view.state.lineBreak)
      view.dispatch({ effects: setBaseline.of({ text, tracked: committed.tracked, authors: committed.authors ?? [] }) })
    })
    void fetchFileSymbols(workspaceId, fileId).then(rows => {
      if (isCurrent()) view.dispatch({ effects: setOutline.of(outlineFromSymbols(view.state.doc, rows)) })
    }).catch(() => { /* no outline: the breadcrumb shows the file alone */ })
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
      const stillDirty = !view.state.doc.eq(text)
      setDirty(stillDirty)
      if (!stillDirty) writeDraft(storageKey, null)
      setConflict(null)
      setShowDiff(false)
      setStatus({ kind: 'saved' })
      return true
    }
    if (result.status === 'conflict') {
      setConflict({ current: result.current, onSave: true })
      setStatus({ kind: 'idle' })
      return false
    }
    setStatus({ kind: 'failed', message: result.error })
    return false
  }, [editable, fileId, workspaceId, storageKey])
  const saveRef = React.useRef(save)
  saveRef.current = save

  /** Do something that leaves this file; with unsaved changes, ask first. */
  const leave = React.useCallback((then: () => void) => {
    if (dirtyRef.current) setLeaving({ then })
    else then()
  }, [])
  const requestClose = React.useCallback(() => leave(onClose), [leave, onClose])

  /** This file at a position, for Back to return to. */
  const here = (position: number): SourcePreviewRequest => {
    const line = viewRef.current ? viewRef.current.state.doc.lineAt(position).number : range?.start ?? 1
    return { fileId, workspaceId, name: source?.relPath ?? symbol.name, lineStart: line, lineEnd: line }
  }

  const goTo = (position: number) => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
    view.focus()
  }

  /** Ctrl+click or F12: this file's own definition first, then the one definition in the project. */
  const openDefinition = async (name: string, position: number) => {
    const view = viewRef.current
    if (!view || !source) return
    const local = definitionInFile(view.state.field(outlineField), name, position, view.state.doc)
    if (local) {
      if (view.state.doc.lineAt(local.from).number === view.state.doc.lineAt(position).number) say(`This is where ${name} is defined.`)
      else goTo(local.from)
      return
    }
    const paths = new Set(useGraphStore.getState().files.map(file => file.relPath.replace(/\\/g, '/')))
    const root = useGraphStore.getState().currentProject?.rootPath
    const found = await resolveSymbol(workspaceId, name, { nearby: [source.relPath], message: [] }, paths, root, true)
    if (!found) { say(`No single definition of ${name} found in the project.`); return }
    if (found.fileId === fileId) { goTo(view.state.doc.line(Math.min(found.lineStart, view.state.doc.lines)).from); return }
    const from = here(position)
    leave(() => useSourcePreviewStore.getState().follow({ fileId: found.fileId, workspaceId, name: found.name, kind: found.kind, lineStart: found.lineStart, lineEnd: found.lineEnd }, from))
  }
  const definitionRef = React.useRef(openDefinition)
  definitionRef.current = openDefinition

  /**
   * Attach what is in front of the person to a message for the agent, as a
   * chip beside it (like a file or sheet), leaving the text for their
   * question: the selected lines, else the lines this viewer was opened at,
   * else the file itself. Then step aside so the conversation is in view.
   */
  const attachedLines = (state: EditorState) => {
    const selection = state.selection.main
    return !selection.empty
      ? { start: state.doc.lineAt(selection.from).number, end: state.doc.lineAt(selection.to === selection.from ? selection.to : selection.to - 1).number }
      : range ? { start: Math.min(range.start, state.doc.lines), end: Math.min(range.end, state.doc.lines) } : undefined
  }
  const askAgent = () => {
    const view = viewRef.current
    if (!view || !source) return
    const lines = attachedLines(view.state)
    window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', { detail: { code: [codeReference(fileId, source.relPath, lines)] } }))
    requestClose()
  }
  const askRef = React.useRef(askAgent)
  askRef.current = askAgent

  const [menu, setMenu] = React.useState<{ x: number; y: number; entries: ContextMenuEntry[] } | null>(null)
  const closeMenu = React.useCallback(() => setMenu(null), [])
  /**
   * Right-click: the usual editing commands, and this viewer's own. A click
   * outside the selection moves the cursor there first, as editors do.
   */
  const openMenu = (event: React.MouseEvent) => {
    const view = viewRef.current
    if (!view || !source) return
    event.preventDefault()
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const before = view.state.selection.main
    if (at !== null && (at < before.from || at > before.to)) view.dispatch({ selection: { anchor: at } })
    const { state } = view
    const position = at ?? state.selection.main.head
    const selected = !state.selection.main.empty
    const writable = !state.readOnly
    const name = nameAt(state, position)
    const change = chunkAt(state, position)
    const mod = window.ambio?.platform === 'darwin' ? '⌘' : 'Ctrl+'
    const lines = attachedLines(state)
    const reference = lines ? `${source.relPath}:${lines.start === lines.end ? lines.start : `${lines.start}-${lines.end}`}` : source.relPath
    const copy = (text: string) => { if (window.ambio?.copyText) void window.ambio.copyText(text); else void navigator.clipboard?.writeText(text) }
    const selectedText = () => state.selection.ranges.map(part => state.sliceDoc(part.from, part.to)).join(state.lineBreak)
    view.focus()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: name ? `Go to Definition of ${name}` : 'Go to Definition', shortcut: 'F12', disabled: !name, run: () => { if (name) void openDefinition(name, position) } },
        { label: 'Ask Agent About This', shortcut: `${mod}I`, run: askAgent },
        'separator',
        { label: 'Cut', shortcut: `${mod}X`, disabled: !selected || !writable, run: () => {
          copy(selectedText())
          view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' })
          view.focus()
        } },
        { label: 'Copy', shortcut: `${mod}C`, disabled: !selected, run: () => { copy(selectedText()); view.focus() } },
        { label: 'Paste', shortcut: `${mod}V`, disabled: !writable || !window.ambio?.pasteIntoFocus, run: () => { view.focus(); void window.ambio?.pasteIntoFocus() } },
        { label: 'Select All', shortcut: `${mod}A`, run: () => { selectAll(view); view.focus() } },
        'separator',
        { label: 'Find', shortcut: `${mod}F`, run: () => { openSearchPanel(view) } },
        { label: lines ? `Copy Reference (${reference.split('/').pop()})` : 'Copy Path', run: () => { copy(reference); say(`Copied ${reference}`); view.focus() } },
        ...(change && writable ? [{ label: 'Revert This Change', run: () => {
          const spec = revertSpec(view.state, change)
          if (spec) view.dispatch(spec)
          view.focus()
        } }] : []),
        ...(fileRecord ? ['separator' as const, { label: 'Show on Map', run: () => leave(() => { onClose(); showOnMap(fileId) }) }] : []),
      ],
    })
  }

  /**
   * Show the file as it is on disk and make that the version edits are based
   * on. The base is set before the change lands, so the reload itself never
   * counts as an unsaved edit.
   */
  function adoptDiskVersion(view: EditorView, disk: FileSource) {
    const transaction = view.state.update(replaceWithin(view.state, disk.content))
    baseRef.current = { hash: disk.hash, text: transaction.state.doc }
    view.dispatch(transaction)
  }

  const draftTimer = React.useRef(0)
  const onChange = (state: EditorState) => {
    const changed = !state.doc.eq(baseRef.current.text!)
    setDirty(changed)
    window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      writeDraft(storageKey, changed ? { content: state.sliceDoc(), baseHash: baseRef.current.hash, savedAt: Date.now() } : null)
    }, 600)
  }
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange

  // The editor is made once, from the version first loaded; saves and reloads keep it.
  const opened = source !== null
  React.useEffect(() => {
    const host = hostRef.current
    if (!opened || !host || !source) return
    baseRef.current = { hash: source.hash, text: null }
    const report = (state: EditorState) => {
      const head = state.selection.main.head
      const line = state.doc.lineAt(head)
      setCursor({
        line: line.number,
        column: head - line.from + 1,
        selected: state.selection.ranges.reduce((total, part) => total + part.to - part.from, 0),
        crumbs: enclosingSymbols(state.field(outlineField), head),
      })
    }
    const view = new EditorView({
      parent: host,
      state: sourceEditorState({
        content: source.content,
        range,
        dynamic: [
          slots.language.of([]),
          slots.readOnly.of([EditorState.readOnly.of(!editable)]),
          slots.diff.of([]),
          // The outline arrives after the editor; the breadcrumb follows it.
          EditorView.updateListener.of(update => { if (update.transactions.some(tr => tr.effects.some(effect => effect.is(setOutline)))) report(update.state) }),
        ],
        onSave: () => { void saveRef.current(); return true },
        onAsk: () => { askRef.current(); return true },
        onChange: state => onChangeRef.current(state),
        onCursor: report,
        onDefinition: (name, position) => { void definitionRef.current(name, position) },
      }),
    })
    baseRef.current.text = view.state.doc
    viewRef.current = view
    if (range) revealLine(view, range.start)
    let current = true
    void languageFor(source.relPath).then(language => {
      if (current && language) view.dispatch({ effects: slots.language.reconfigure(language) })
    })
    refreshContext(view, () => current)
    const draft = readDraft(storageKey)
    if (draft && draft.content !== source.content && editable) setDraftOffer(draft)
    else if (draft) writeDraft(storageKey, null)
    return () => {
      current = false
      window.clearTimeout(draftTimer.current)
      view.destroy()
      viewRef.current = null
    }
    // Only a newly opened file makes a new editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  // The watcher reindexed this file: an agent or another editor wrote it.
  const lastRecord = React.useRef(fileRecord)
  React.useEffect(() => {
    if (lastRecord.current === fileRecord) return
    lastRecord.current = fileRecord
    const view = viewRef.current
    if (!view || !fileRecord) return
    let current = true
    void apiGetFileSource(fileId, workspaceId).then(disk => {
      if (!current || disk.hash === baseRef.current.hash) return
      if (dirtyRef.current) {
        setConflict({ current: disk, onSave: false })
        return
      }
      adoptDiskVersion(view, disk)
      setSource(disk)
      say(`${disk.relPath} changed on disk; showing it now.`)
      refreshContext(view, () => current)
    }).catch(() => { /* the save check still guards against overwriting it */ })
    return () => { current = false }
  }, [fileRecord, fileId, workspaceId, refreshContext, say])

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: slots.diff.reconfigure(showDiff && conflict ? unifiedMergeView({ original: conflict.current.content, mergeControls: false, gutter: true }) : []) })
  }, [showDiff, conflict, slots])

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
    adoptDiskVersion(view, conflict.current)
    writeDraft(storageKey, null)
    setSource(conflict.current)
    setDirty(false)
    setConflict(null)
    setShowDiff(false)
    setStatus({ kind: 'idle' })
  }

  const restoreDraft = () => {
    const view = viewRef.current
    if (!view || !draftOffer) return
    // The person's own edits: marked as theirs, saved over the version they were made against.
    view.dispatch({ ...replaceWithin(view.state, draftOffer.content), userEvent: 'input.restore' })
    baseRef.current = { ...baseRef.current, hash: draftOffer.baseHash }
    setDraftOffer(null)
  }

  const finishLeaving = (then: () => void) => {
    writeDraft(storageKey, null)
    setLeaving(null)
    then()
  }

  const title = source?.relPath ?? fileId
  const lineCount = React.useMemo(() => {
    if (!source?.content) return 0
    const lines = source.content.split(/\r\n|\n/)
    return lines.at(-1) === '' ? lines.length - 1 : lines.length
  }, [source])
  const indent = React.useMemo(() => source ? detectIndent(source.content).label : '', [source])
  const statusText = !source ? ''
    : !source.editable ? 'read-only: not UTF-8 text'
      : !editable ? 'read-only: too large to edit here'
        : status.kind === 'saving' ? 'saving…'
          : status.kind === 'failed' ? `not saved: ${status.message}`
            : status.kind === 'saved' && !dirty ? 'saved' : ''

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
            <div className="source-preview-path" title={title}>
              <span className="source-preview-path-text">{title}</span>
              {dirty && <span className="source-preview-unsaved" title="Unsaved changes" role="img" aria-label="Unsaved changes" />}
            </div>
            <div className="source-preview-location">
              {!range ? (source ? `${lineCount} lines` : '')
                : <>
                  {symbol.kind ? `${symbol.kind} ${symbol.name} · ` : ''}{range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`}
                  {source && range.start > lineCount && ` · past the end of this ${lineCount}-line file; it may have changed since`}
                </>}
            </div>
          </div>
          <div className="source-preview-actions">
            {statusText && <span className={`source-preview-status${status.kind === 'failed' ? ' source-preview-status-error' : ''}`} role="status">{statusText}</span>}
            {history.length > 0 && <button type="button" className="source-preview-button" onClick={() => leave(() => useSourcePreviewStore.getState().back())} title="Back to where you followed this definition from">Back</button>}
            {fileRecord && <button type="button" className="source-preview-button" onClick={() => leave(() => { onClose(); showOnMap(fileId) })} title="Close the editor and show this file on the map">Show on map</button>}
            {source && <button type="button" className="source-preview-button" onClick={askAgent} title="Attach the selected lines (or this file) to a message for your agent (Ctrl+I)">Ask agent</button>}
            {editable && <button type="button" className="source-preview-button" disabled={!dirty || status.kind === 'saving'} onClick={() => { void save() }} title="Save (Ctrl+S)">Save</button>}
            <button autoFocus className="source-preview-close" onClick={requestClose} aria-label="Close source preview">×</button>
          </div>
        </header>
        {source && (
          <nav className="source-preview-breadcrumb" aria-label="Where the cursor is">
            {systemName && fileRecord?.systemId && <><button type="button" onClick={() => leave(() => { onClose(); showOnMap(fileRecord.systemId!) })} title="Show this system on the map">{systemName}</button><span aria-hidden="true">›</span></>}
            <span>{title.split('/').pop()}</span>
            {cursor.crumbs.map(crumb => <React.Fragment key={`${crumb.kind}:${crumb.name}:${crumb.from}`}><span aria-hidden="true">›</span><button type="button" onClick={() => goTo(crumb.from)} title={`Go to ${crumb.kind} ${crumb.name}`}>{crumb.name}</button></React.Fragment>)}
          </nav>
        )}
        {draftOffer && !conflict && (
          <div className="source-preview-bar" role="alert">
            <span>You have unsaved changes to {title} from {ago(draftOffer.savedAt)}{draftOffer.baseHash !== source?.hash ? '; the file has changed since, so saving them will show the differences first' : ''}.</span>
            <button type="button" className="source-preview-button" onClick={restoreDraft}>Restore them</button>
            <button type="button" className="source-preview-button" onClick={() => { writeDraft(storageKey, null); setDraftOffer(null) }}>Discard them</button>
          </div>
        )}
        {conflict && (
          <div className="source-preview-bar" role="alert">
            <span>{conflict.current.relPath} changed on disk while you were editing.{conflict.onSave ? ' Nothing was saved.' : ''}</span>
            <button type="button" className="source-preview-button" onClick={() => setShowDiff(shown => !shown)}>{showDiff ? 'Hide differences' : 'Show differences'}</button>
            <button type="button" className="source-preview-button" onClick={() => { void save(conflict.current.hash) }}>Keep mine</button>
            <button type="button" className="source-preview-button" onClick={takeDiskVersion}>Use the file on disk</button>
          </div>
        )}
        {leaving && (
          <div className="source-preview-bar" role="alert">
            <span>Save your changes to {title}?</span>
            <button type="button" className="source-preview-button" onClick={() => { void save().then(saved => { if (saved) finishLeaving(leaving.then); else setLeaving(null) }) }}>Save and continue</button>
            <button type="button" className="source-preview-button" onClick={() => finishLeaving(leaving.then)}>Discard</button>
            <button type="button" className="source-preview-button" onClick={() => { setLeaving(null); viewRef.current?.focus() }}>Keep editing</button>
          </div>
        )}
        <div className="source-preview-code" aria-busy={!source && !error}>
          {!source && !error && <div className="source-preview-message">Loading source…</div>}
          {error && <div className="source-preview-message source-preview-error">{error}</div>}
          <div ref={hostRef} className="source-preview-editor" hidden={!source} onContextMenu={openMenu} />
        </div>
        {source && (
          <footer className="source-preview-statusline">
            <span>Ln {cursor.line}, Col {cursor.column}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</span>
            <span className="source-preview-notice" aria-live="polite">{notice}</span>
            <span className="source-preview-statusline-end">{languageName(source.relPath)}</span>
            <span>{viewRef.current?.state.lineBreak === '\r\n' ? 'CRLF' : 'LF'}</span>
            <span>{indent}</span>
          </footer>
        )}
      </section>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} label="Code" />}
    </div>,
    document.body,
  )
}
