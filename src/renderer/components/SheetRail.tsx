// SheetRail - the drafting-cabinet drawer labels: The Floor pinned on top,
// sheets beneath (docs/history/UML_UX_PLAN.md "Navigation: the sheet rail").
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { untakenSheetName } from '../../shared/sheetNames'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore, type Sheet } from '../store/sheetStore'
import { archdApi } from '../archdEndpoint.ts'
import { SheetRemovedList } from './SheetRemovedList'
import { useSheetView } from '../canvas/sheetView'
import { COMMANDS } from '../../shared/appMenu'
import { SheetChangeDetails } from './SheetChangeDetails'
import { SheetProposalReview } from './SheetProposalReview'
import { plannedFilename } from '../canvas/plannedFileIdentity'
import { useShowOnMap } from '../canvas/useShowOnMap'

function SheetContents() {
  const layer = useSheetStore(state => state.activeSheetId ? state.layersById[state.activeSheetId] : undefined)
  const { files, systems } = useGraphStore(useShallow(state => ({ files: state.files, systems: state.systems })))
  const showOnMap = useShowOnMap(false)
  if (!layer) return null
  const planned = layer.planned.filter(node => node.status !== 'flattened' && node.approvalStatus !== 'rejected')
  const edges = layer.plannedEdges.filter(edge => edge.approvalStatus !== 'rejected')
  const removed = new Set(layer.removals?.map(item => item.nodeId))
  const live = layer.elements.map(element => ({ element, id: element.fileId ?? element.systemId ?? '' })).filter(item => item.id && !removed.has(item.id))
  if (!planned.length && !edges.length && !live.length) return null
  const label = (id: string) => {
    const node = planned.find(node => `planned:${node.id}` === id)
    return node ? node.kind === 'file' ? plannedFilename(node) : node.name
      : files.find(file => file.id === id)?.relPath.split(/[\\/]/).pop() ?? systems.find(system => system.id === id)?.name ?? 'Unavailable item'
  }
  const visited = new Set<string>()
  const entries: Array<{ node: typeof planned[number]; depth: number }> = []
  const append = (node: typeof planned[number], depth: number) => {
    if (visited.has(node.id)) return
    visited.add(node.id); entries.push({ node, depth })
    for (const child of planned) if (child.parentSystemId === `planned:${node.id}`) append(child, depth + 1)
  }
  for (const node of planned) if (!planned.some(parent => `planned:${parent.id}` === node.parentSystemId)) append(node, 0)
  for (const node of planned) append(node, 0)
  const focus = (id: string) => { useSheetView.getState().focusRelationship(null); showOnMap(id) }
  return <details className="ambio-sheet-contents" aria-label="Sheet contents">
    <summary>Contents <span>{planned.length + live.length}</span></summary>
    <div className="ambio-sheet-contents__body">
      <ul>
        {entries.map(({ node, depth }) => <li key={node.id} style={{ paddingLeft: Math.min(depth, 4) * 10 }}>
          <button type="button" title={node.declaredPath || node.name} aria-label={`Show ${label(`planned:${node.id}`)} on sheet`} onClick={() => focus(`planned:${node.id}`)}>{label(`planned:${node.id}`)}</button>
          <small>{node.approvalStatus === 'approved' ? 'Approved' : 'To review'}</small>
        </li>)}
        {live.map(({ element, id }) => <li key={element.id}><button type="button" aria-label={`Show ${label(id)} on sheet`} onClick={() => focus(id)}>{label(id)}</button><small>Existing</small></li>)}
      </ul>
      {edges.length > 0 && <details><summary>Relationships ({edges.length})</summary><ul>{edges.map(edge => {
        const source = edge.srcPlanned ? `planned:${edge.srcPlanned}` : edge.srcLive ?? ''
        const target = edge.dstPlanned ? `planned:${edge.dstPlanned}` : edge.dstLive ?? ''
        return <li key={edge.id}><button type="button" onClick={() => { useGraphStore.getState().setSelectedNode(source); useGraphStore.getState().setInspectedNode(null); useSheetView.getState().focusRelationship(edge.id) }}>{label(source)} → {label(target)}</button><small>{edge.approvalStatus === 'approved' ? 'Approved' : 'To review'}</small></li>
      })}</ul></details>}
      {planned.some(node => node.approvalStatus === 'approved') && <div className="ambio-sheet-contents__next">
        <p>Approval confirms the plan. Implementation is separate.</p>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', { detail: { sheetId: layer.sheet.id } }))}>Discuss or implement</button>
      </div>}
    </div>
  </details>
}

const SHEET_KIND_LABELS: Record<Sheet['kind'], string> = {
  structure: 'STR',
  class: 'CLS',
  sequence: 'SEQ',
  intent: 'INT',
}

function FloorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" />
      <path d="M3 9h18M9 3v18" />
    </svg>
  )
}

function SheetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h13l3 3v13H4z" />
      <path d="M17 4v3h3" />
    </svg>
  )
}

export function SheetRail() {
  const allRelationships = useSheetView(s => s.allRelationships)
  const toggleRelationships = useSheetView(s => s.toggleRelationships)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const { sheets, activeSheetId, visibleSheetIds, fetchSheets, openSheet, toggleSheetVisibility, createSheet, deleteSheet } =
    useSheetStore(useShallow(s => ({
      sheets: s.sheets,
      activeSheetId: s.activeSheetId,
      visibleSheetIds: s.visibleSheetIds,
      fetchSheets: s.fetchSheets,
      openSheet: s.openSheet,
      toggleSheetVisibility: s.toggleSheetVisibility,
      createSheet: s.createSheet,
      deleteSheet: s.deleteSheet,
    })))
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newName, setNewName] = useState('New Sheet')
  const [createError, setCreateError] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  // Agent-drawn sheets you have not opened yet are marked NEW. Remembered per
  // viewer only; losing it just shows the mark again.
  const seenKey = `ambio:seen-agent-sheets:${workspaceId}`
  const [seenAgentSheets, setSeenAgentSheets] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(seenKey) ?? '[]') as string[] } catch { return [] }
  })
  useEffect(() => {
    if (!activeSheetId || seenAgentSheets.includes(activeSheetId)) return
    if (!sheets.some(sheet => sheet.id === activeSheetId && sheet.createdBy === 'agent')) return
    const next = [...seenAgentSheets, activeSheetId]
    setSeenAgentSheets(next)
    try { localStorage.setItem(seenKey, JSON.stringify(next)) } catch { /* the mark just returns */ }
  }, [activeSheetId, sheets, seenAgentSheets, seenKey])
  const activeSheets = sheets.filter(sheet => !sheet.resolvedAt)
  const resolvedSheets = sheets.filter(sheet => sheet.resolvedAt)
  const restore = async (sheet: Sheet) => {
    setRestoreError('')
    try {
      const response = await fetch(`${archdApi()}/api/sheets/${encodeURIComponent(sheet.id)}/reopen`, {
        method: 'POST', headers: { 'Content-Type':'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ workspaceId, revision: sheet.revision }),
      })
      if (!response.ok) throw new Error(await response.text())
      await fetchSheets(workspaceId)
      await openSheet(workspaceId, sheet.id)
    } catch (err) { setRestoreError(err instanceof Error ? err.message : String(err)) }
  }
  const newNameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (workspaceId) void fetchSheets(workspaceId)
  }, [workspaceId, fetchSheets])

  useEffect(() => {
    if (!creating) return
    newNameInput.current?.focus()
    newNameInput.current?.select()
  }, [creating])

  const beginCreating = () => {
    setNewName(untakenSheetName(sheets, 'New Sheet'))
    setCreateError(null)
    setCreating(true)
  }

  const cancelCreating = () => {
    if (submitting) return
    setCreateError(null)
    setCreating(false)
  }

  const submitNewSheet = async (event: FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || submitting) return

    setSubmitting(true)
    setCreateError(null)
    try {
      const sheet = await createSheet(workspaceId, name, '', [])
      setCreating(false)
      void openSheet(workspaceId, sheet.id)
    } catch (err) {
      // Stay in the row with the name still typed: the fix is almost always a
      // one-word edit, not starting over.
      setCreateError(err instanceof Error ? err.message : 'Could not create the sheet.')
      newNameInput.current?.focus()
      newNameInput.current?.select()
    } finally {
      setSubmitting(false)
    }
  }

  const railButtonClass = (active: boolean) => [
    'ambio-sheet-rail__button',
    active ? 'ambio-sheet-rail__button--active' : '',
  ].filter(Boolean).join(' ')

  return (
    <aside className="ambio-sheet-rail" aria-label="Drawings">
      <header className="ambio-sheet-rail__titlebar">
        <span>Drawings</span>
        <span className="ambio-sheet-rail__title-meta" aria-label={`${activeSheets.length} overlay sheets`}>
          {String(activeSheets.length).padStart(2, '0')} SHEETS
        </span>
      </header>

      <div className="ambio-sheet-rail__section-label">
        <span>Live model</span>
        <span className="ambio-sheet-rail__section-rule" />
      </div>

      {/* The Floor - the live master canvas, always pinned. */}
      <button
        className={`${railButtonClass(activeSheetId === null)} ambio-sheet-rail__button--floor`}
        aria-current={activeSheetId === null ? 'page' : undefined}
        onClick={() => void openSheet(workspaceId, null)}
      >
        <span className="ambio-sheet-rail__document-icon"><FloorIcon /></span>
        <span className="ambio-sheet-rail__name">The Floor</span>
        <span className="ambio-sheet-rail__live">Live</span>
      </button>

      <div className="ambio-sheet-rail__section-label ambio-sheet-rail__section-label--overlays">
        <span>Overlay sheets</span>
        <span className="ambio-sheet-rail__section-rule" />
        <button
          type="button"
          className="ambio-sheet-rail__add-sheet"
          aria-label="Create new overlay sheet"
          aria-expanded={creating}
          disabled={creating}
          onClick={beginCreating}
        >
          +
        </button>
      </div>

      <div className="ambio-sheet-rail__list">
        {creating && (
          <form className="ambio-sheet-rail__row ambio-sheet-rail__row--creating" onSubmit={submitNewSheet}>
            <span className="ambio-sheet-rail__visibility-slot" aria-hidden="true" />
            <span className="ambio-sheet-rail__document-icon"><SheetIcon /></span>
            <input
              ref={newNameInput}
              className="ambio-sheet-rail__name-input"
              aria-label="New sheet name"
              value={newName}
              disabled={submitting}
              spellCheck={false}
              aria-invalid={createError ? true : undefined}
              onChange={event => {
                setNewName(event.target.value)
                setCreateError(null)
              }}
              onKeyDown={event => {
                event.stopPropagation()
                if (event.key === 'Escape') cancelCreating()
              }}
            />
            <span className="ambio-sheet-rail__commit-hint" aria-hidden="true">
              {submitting ? '…' : '↵'}
            </span>
          </form>
        )}

        {creating && createError && (
          <p className="ambio-sheet-rail__create-error" role="alert">{createError}</p>
        )}

        {activeSheets.map(sheet => {
          const active = activeSheetId === sheet.id
          const visible = visibleSheetIds.includes(sheet.id)
          return (
            <div
              key={sheet.id}
              className={[
                'ambio-sheet-rail__row',
                active ? 'ambio-sheet-rail__row--active' : '',
              ].filter(Boolean).join(' ')}
            >
              <button
                type="button"
                className={[
                  'ambio-sheet-rail__visibility',
                  visible ? 'ambio-sheet-rail__visibility--visible' : '',
                ].filter(Boolean).join(' ')}
                title={visible ? 'Hide layer' : 'Show layer'}
                aria-label={visible ? `Hide ${sheet.name}` : `Show ${sheet.name}`}
                aria-pressed={visible}
                onClick={() => void toggleSheetVisibility(workspaceId, sheet.id)}
              >
                {visible && (
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m2.1 6.2 2.3 2.2 5.5-5.2" />
                  </svg>
                )}
              </button>

              <button
                type="button"
                className={`${railButtonClass(active)} ambio-sheet-rail__button--sheet`}
                aria-current={active ? 'page' : undefined}
                onClick={() => void openSheet(workspaceId, sheet.id)}
              >
                <span className="ambio-sheet-rail__document-icon"><SheetIcon /></span>
                <span className="ambio-sheet-rail__name" title={sheet.name}>{sheet.name}</span>
                <span className="ambio-sheet-rail__kind">{SHEET_KIND_LABELS[sheet.kind]}</span>
                {sheet.createdBy === 'agent' && <span className="ambio-sheet-rail__agent" title="Created by agent">AI</span>}
                {sheet.createdBy === 'agent' && !active && !seenAgentSheets.includes(sheet.id) && <span className="ambio-sheet-rail__new" title="Drawn by an agent; not opened yet">NEW</span>}
              </button>

              {active && <button type="button" className="ambio-sheet-rail__attach" aria-label={`Attach ${sheet.name} to agent message`} title="Discuss or implement this sheet" onClick={() => window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', { detail: { sheetId: sheet.id } }))}>↗</button>}
              {active && (
                <button
                  type="button"
                  className="ambio-sheet-rail__delete"
                  aria-label={`Delete ${sheet.name}`}
                  title="Delete sheet"
                  onClick={() => {
                    if (confirm(`Delete sheet "${sheet.name}"?`)) void deleteSheet(workspaceId, sheet.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
      <SheetProposalReview workspaceId={workspaceId} />
      <SheetContents key={activeSheetId ?? 'floor'} />
      {activeSheetId && <label className="ambio-sheet-rail__relationships"><input type="checkbox" checked={allRelationships} onChange={toggleRelationships} />{COMMANDS['view.sheetRelationships'].label}</label>}
      <SheetChangeDetails />
      <SheetRemovedList workspaceId={workspaceId} />
      {resolvedSheets.length > 0 && <div className="ambio-sheet-rail__archive">
        <button type="button" aria-expanded={showResolved} onClick={() => setShowResolved(value => !value)}>Resolved sheets ({resolvedSheets.length})</button>
        {showResolved && resolvedSheets.map(sheet => <div key={sheet.id}><span>{sheet.name}</span><button type="button" onClick={() => { void restore(sheet) }}>Restore {sheet.name}</button></div>)}
        {restoreError && <p role="alert">{restoreError}</p>}
      </div>}
    </aside>
  )
}
