// SheetRail - the drafting-cabinet drawer labels: The Floor pinned on top,
// sheets beneath (docs/history/UML_UX_PLAN.md "Navigation: the sheet rail").
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { untakenSheetName } from '../../shared/sheetNames'
import { useGraphStore } from '../store/graphStore'
import { handleSheetPatch, sheetElementHasChange, useSheetStore, type Sheet } from '../store/sheetStore'
import { archdApi } from '../archdEndpoint.ts'
import { SheetRemovedList } from './SheetRemovedList'
import { useSheetView } from '../canvas/sheetView'
import { COMMANDS, SHEET_ACTIONS } from '../../shared/appMenu'
import { SheetChangeDetails } from './SheetChangeDetails'
import { SheetProposalReview } from './SheetProposalReview'
import { plannedFilename } from '../canvas/plannedFileIdentity'
import { useShowOnMap } from '../canvas/useShowOnMap'

/** Each sheet owns its navigation, including approved content. Expanding does
 * not change the active editing target or the visible overlay layers. */
function SheetContents({ sheetId, workspaceId }: { sheetId: string; workspaceId: string }) {
  const layer = useSheetStore(state => state.layersById[sheetId])
  const { files, systems, infraNodes, floorLayouts } = useGraphStore(useShallow(state => ({ files: state.files, systems: state.systems, infraNodes: state.infraNodes, floorLayouts: state.floorLayouts })))
  const floorParents = useMemo(() => new Map<string, string | null>([
    ...systems.map(node => [node.id, node.parentId] as const),
    ...files.map(node => [node.id, node.systemId] as const),
    ...floorLayouts.map(row => [row.nodeId, row.parentNodeId] as const),
  ]), [systems, files, floorLayouts])
  const showOnMap = useShowOnMap(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const connectionsId = useId()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void useSheetStore.getState().loadSheetContents(workspaceId, sheetId).catch(error => {
      if (current) setError(error instanceof Error ? error.message : String(error))
    })
    return () => { current = false }
  }, [workspaceId, sheetId])
  if (!layer) return <p className="ambio-sheet-tree__empty" role={error ? 'alert' : 'status'}>{error || 'Loading contents…'}</p>
  const planned = layer.planned.filter(node => node.status !== 'flattened' && node.approvalStatus !== 'rejected')
  const edges = layer.plannedEdges.filter(edge => edge.approvalStatus !== 'rejected')
  const removed = new Set(layer.removals?.map(item => item.nodeId))
  const references = layer.elements.map(element => ({ element, id: element.fileId ?? element.systemId ?? element.infraId ?? element.symbolRef ?? '' })).filter(item => item.id && !removed.has(item.id))
  const sheetParents = new Map(layer.layouts.map(row => [row.nodeId, row.parentNodeId]))
  // Being named as context, receiving a connection, or shifting on the canvas
  // does not make a live node a proposed change. Keep actual responsibility
  // moves, reviewed renames and authored file design here; edges have their
  // own navigator below, including their unchanged live endpoints.
  const live = references.filter(({ element, id }) => {
    const parent = sheetParents.has(id) ? sheetParents.get(id) : element.parentSystemId
    return sheetElementHasChange(element, floorParents.get(id) ?? null, parent ?? null)
  })
  const label = (id: string) => {
    const node = planned.find(node => `planned:${node.id}` === id)
    return node ? node.kind === 'file' ? plannedFilename(node) : node.name
      : files.find(file => file.id === id)?.relPath.split(/[\\/]/).pop() ?? systems.find(system => system.id === id)?.name
        ?? infraNodes.find(node => node.id === id)?.name ?? references.find(item => item.id === id)?.element.label ?? 'Unavailable item'
  }
  const focus = async (id: string, relationship?: string) => {
    await useSheetStore.getState().openSheet(workspaceId, sheetId)
    if (useSheetStore.getState().activeSheetId !== sheetId) return
    useSheetView.getState().focusRelationship(null)
    if (relationship) {
      useGraphStore.getState().setSelectedNode(id)
      useGraphStore.getState().setInspectedNode(null)
      // The canvas resets relationship focus when its active sheet changes.
      requestAnimationFrame(() => {
        if (useSheetStore.getState().activeSheetId === sheetId) useSheetView.getState().focusRelationship(relationship)
      })
    } else showOnMap(id)
  }
  const visited = new Set<string>()
  const entries: Array<{ id: string; depth: number; pending: boolean; container: boolean; path?: string }> = []
  const append = (node: typeof planned[number], depth: number) => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    const id = `planned:${node.id}`
    const children = planned.filter(child => child.parentSystemId === id)
    entries.push({ id, depth, pending: node.approvalStatus === 'pending', container: ['system', 'service', 'infra'].includes(node.kind), path: node.declaredPath })
    for (const child of children) append(child, depth + 1)
  }
  for (const node of planned) if (!planned.some(parent => `planned:${parent.id}` === node.parentSystemId)) append(node, 0)
  for (const node of planned) append(node, 0)
  // Keep each descendant range inside its disclosure so height can animate
  // without adding indentation or exposing closed controls to the keyboard.
  const renderEntries = (start = 0, end = entries.length): ReactNode[] => {
    const rows: ReactNode[] = []
    for (let index = start; index < end;) {
      const entry = entries[index]
      let next = index + 1
      while (next < end && entries[next].depth > entry.depth) next++
      const hasChildren = next > index + 1
      rows.push(<li key={entry.id} className="ambio-sheet-tree__node">
        <div className={`ambio-sheet-tree__node-row ${entry.container ? 'ambio-sheet-tree__system' : 'ambio-sheet-tree__file'}`} data-nested={entry.depth > 0 || undefined}>
          {!entry.container && <span className="ambio-sheet-tree__mark" data-pending={entry.pending || undefined} title={entry.pending ? 'Needs review' : undefined} aria-label={entry.pending ? 'Needs review' : undefined} />}
          <button type="button" className="ambio-sheet-tree__item" title={entry.path || label(entry.id)} aria-label={`Show ${label(entry.id)} on sheet`} onClick={() => void focus(entry.id)}>
            {entry.container && <SystemIcon pending={entry.pending} />}<span>{label(entry.id)}</span>
          </button>
          {hasChildren && <button type="button" className="ambio-sheet-tree__branch" aria-label={`${collapsed.has(entry.id) ? 'Expand' : 'Collapse'} ${label(entry.id)}`} aria-expanded={!collapsed.has(entry.id)} onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next })}><Chevron expanded={!collapsed.has(entry.id)} /></button>}
        </div>
        {hasChildren && <SheetDisclosure open={!collapsed.has(entry.id)}><ul>{renderEntries(index + 1, next)}</ul></SheetDisclosure>}
      </li>)
      index = next
    }
    return rows
  }
  return <div className="ambio-sheet-tree" role="group" aria-label={`Contents of ${layer.sheet.name}`}>
    <ul>
      {renderEntries()}
      {live.map(({ element, id }) => <li key={element.id} className={element.fileId ? 'ambio-sheet-tree__file' : 'ambio-sheet-tree__system'}>
        {element.fileId && <span className="ambio-sheet-tree__mark" />}<button type="button" className="ambio-sheet-tree__item" aria-label={`Show ${label(id)} on sheet`} onClick={() => void focus(id)}>{!element.fileId && <SystemIcon />}<span>{label(id)}</span></button>
      </li>)}
    </ul>
    {!entries.length && !live.length && !edges.length && <p className="ambio-sheet-tree__empty">No proposed changes yet.</p>}
    {edges.length > 0 && <div className="ambio-sheet-tree__connections">
      <button type="button" className="ambio-sheet-tree__heading" aria-expanded={connectionsOpen} aria-controls={connectionsId} onClick={() => setConnectionsOpen(value => !value)}>
        <svg className="ambio-sheet-connections-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3h3v10h3M8 8h3" /><rect x="1" y="1" width="4" height="4" /><rect x="11" y="6" width="4" height="4" /><rect x="11" y="11" width="4" height="4" /></svg>
        <span className="ambio-sheet-tree__connections-label">Connections</span><span className="ambio-sheet-tree__connections-count">{edges.length}</span><Chevron expanded={connectionsOpen} />
      </button>
      <SheetDisclosure open={connectionsOpen} id={connectionsId}><ul>{edges.map(edge => {
        const source = edge.srcPlanned ? `planned:${edge.srcPlanned}` : edge.srcLive ?? ''
        const target = edge.dstPlanned ? `planned:${edge.dstPlanned}` : edge.dstLive ?? ''
        return <li key={edge.id}><button type="button" className="ambio-sheet-tree__item" onClick={() => void focus(source, edge.id)}>{label(source)} → {label(target)}</button></li>
      })}</ul></SheetDisclosure>
      <SheetConnectionsControl sheetId={sheetId} />
    </div>}
  </div>
}

/** Mount on first opening, then retain state through reversible CSS folds. */
function SheetDisclosure({ open, id, className = '', children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  const [opened, setOpened] = useState(open)
  useEffect(() => { if (open) setOpened(true) }, [open])
  return <div ref={node => { if (node) node.inert = !open }} id={id} className={`ambio-sheet-disclosure ${className}`} data-open={open || undefined} aria-hidden={!open}>
    <div className="ambio-sheet-disclosure__clip">{(open || opened) && children}</div>
  </div>
}

function SystemIcon({ pending }: { pending?: boolean }) {
  return <span className="ambio-sheet-tree__system-icon" data-pending={pending || undefined} title={pending ? 'Needs review' : undefined} aria-label={pending ? 'Needs review' : undefined}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 4h5l2 2h7v8H1Z" /></svg>
  </span>
}

function SheetConnectionsControl({ sheetId }: { sheetId: string }) {
  const active = useSheetStore(state => state.activeSheetId === sheetId)
  const allRelationships = useSheetView(state => state.allRelationships)
  if (!active) return null
  return <button type="button" className="ambio-sheet-tree__show-connections" aria-label={COMMANDS['view.sheetRelationships'].label} aria-pressed={allRelationships} onClick={() => useSheetView.getState().toggleRelationships()}>
    <svg className="ambio-sheet-connections-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" /><circle cx="8" cy="8" r="2" /></svg>
    {allRelationships ? 'Hide connections on map' : 'Show connections on map'}
  </button>
}

function Chevron({ expanded }: { expanded: boolean }) {
  return <svg className="ambio-sheet-chevron" viewBox="0 0 12 12" aria-hidden="true" data-expanded={expanded}><path d="m4 2 4 4-4 4" /></svg>
}

function SheetEntry({ sheet, workspaceId }: { sheet: Sheet; workspaceId: string }) {
  const active = useSheetStore(state => state.activeSheetId === sheet.id)
  const visible = useSheetStore(state => state.visibleSheetIds.includes(sheet.id))
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(sheet.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const titleButton = useRef<HTMLButtonElement>(null)
  const menuId = useId(), contentsId = useId()
  useEffect(() => {
    const panel = menu.current
    if (!panel) return
    panel.popover = 'auto'
    const toggle = () => setMenuOpen(panel.matches(':popover-open'))
    panel.addEventListener('toggle', toggle)
    // Scroll/resize closes a context menu rather than leaving it detached.
    const close = () => { if (panel.matches(':popover-open')) panel.hidePopover() }
    window.addEventListener('resize', close)
    const rail = titleButton.current?.closest('.ambio-sheet-rail__list')
    rail?.addEventListener('scroll', close)
    return () => { panel.removeEventListener('toggle', toggle); window.removeEventListener('resize', close); rail?.removeEventListener('scroll', close) }
  }, [])
  const closeMenu = () => { menu.current?.hidePopover(); menuButton.current?.focus() }
  const showMenu = (x?: number, y?: number) => {
    const panel = menu.current, anchor = menuButton.current
    if (!panel || !anchor) return
    if (panel.matches(':popover-open')) { closeMenu(); return }
    panel.showPopover()
    const rect = anchor.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(x ?? rect.left, window.innerWidth - panel.offsetWidth - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(y ?? rect.bottom + 4, window.innerHeight - panel.offsetHeight - 8))}px`
    panel.querySelector<HTMLButtonElement>('button')?.focus()
  }
  const rename = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true); setError('')
    try {
      const response = await fetch(`${archdApi()}/api/sheets/${encodeURIComponent(sheet.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, name: name.trim() }), signal: AbortSignal.timeout(15000) })
      if (!response.ok) { const text = await response.text(); let message = text; try { message = JSON.parse(text).error ?? text } catch { /* plain text error */ }; throw new Error(message) }
      const updated = await response.json()
      handleSheetPatch({ type: 'sheet:upserted', payload: updated })
      setRenaming(false); titleButton.current?.focus()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  return <div className="ambio-sheet-entry" data-expanded={expanded || undefined} data-active={active || undefined}>
    <div className={`ambio-sheet-rail__row${active ? ' ambio-sheet-rail__row--active' : ''}${visible ? ' ambio-sheet-rail__row--visible' : ''}`} onContextMenu={event => { event.preventDefault(); showMenu(event.clientX, event.clientY) }} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); showMenu() } }}>
      <button type="button" className="ambio-sheet-rail__expand" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${sheet.name}`} aria-expanded={expanded} aria-controls={contentsId} onClick={() => setExpanded(value => !value)}><Chevron expanded={expanded} /></button>
      <button ref={titleButton} type="button" className={`ambio-sheet-rail__button ambio-sheet-rail__button--sheet${active ? ' ambio-sheet-rail__button--active' : ''}`} aria-current={active ? 'page' : undefined} title={`${sheet.name} · Ctrl/Cmd-click to toggle layer`} onClick={event => {
        const store = useSheetStore.getState()
        if ((event.ctrlKey || event.metaKey) && store.activeSheetId) void store.toggleSheetVisibility(workspaceId, sheet.id)
        else void store.openSheet(workspaceId, sheet.id, { exclusive: true })
      }}><span className="ambio-sheet-rail__name">{sheet.name}</span></button>
      <button ref={menuButton} type="button" className="ambio-sheet-rail__more" aria-label={`Actions for ${sheet.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => showMenu()}>⋯</button>
    </div>
    <div ref={menu} id={menuId} className="ambio-sheet-menu" role="menu" aria-label={`Actions for ${sheet.name}`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]; const index = options.indexOf(document.activeElement as HTMLButtonElement)
        options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length]?.focus()
      }
    }}>
      <button type="button" role="menuitem" onClick={() => { closeMenu(); setName(sheet.name); setError(''); setRenaming(true) }}>{SHEET_ACTIONS.rename}</button>
      <button type="button" role="menuitem" onClick={() => { closeMenu(); window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', { detail: { sheetId: sheet.id } })) }}>{SHEET_ACTIONS.discuss}</button>
      <button type="button" role="menuitem" className="ambio-sheet-menu__delete" onClick={() => { closeMenu(); if (confirm(`Delete sheet "${sheet.name}"?`)) void useSheetStore.getState().deleteSheet(workspaceId, sheet.id).catch(error => setError(String(error))) }}>{SHEET_ACTIONS.delete}</button>
    </div>
    {renaming && <form className="ambio-sheet-rail__rename" onSubmit={event => void rename(event)}>
      <input autoFocus aria-label="Sheet name" value={name} disabled={saving} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !saving) { setRenaming(false); titleButton.current?.focus() } }} />
      <button type="submit" disabled={saving || !name.trim()}>Save</button><button type="button" disabled={saving} onClick={() => { setRenaming(false); titleButton.current?.focus() }}>Cancel</button>
    </form>}
    {error && <p className="ambio-sheet-rail__create-error" role="alert">{error}</p>}
    <SheetDisclosure id={contentsId} className="ambio-sheet-entry__contents" open={expanded}>
      <div className="ambio-sheet-entry__body"><SheetContents sheetId={sheet.id} workspaceId={workspaceId} /></div>
    </SheetDisclosure>
  </div>
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
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const { sheets, activeSheetId, fetchSheets, openSheet, createSheet } =
    useSheetStore(useShallow(s => ({
      sheets: s.sheets,
      activeSheetId: s.activeSheetId,
      fetchSheets: s.fetchSheets,
      openSheet: s.openSheet,
      createSheet: s.createSheet,
    })))
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newName, setNewName] = useState('New Sheet')
  const [createError, setCreateError] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [restoreError, setRestoreError] = useState('')
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

        {activeSheets.map(sheet => <SheetEntry key={`${workspaceId}:${sheet.id}`} sheet={sheet} workspaceId={workspaceId} />)}
      </div>
      <SheetProposalReview workspaceId={workspaceId} />
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
