import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'
import { fetchFileSymbols } from '../canvas/symbolCache'
import { buildOutline, UNSORTED_ID, type OutlineRow } from '../canvas/modelOutline'
import type { DbSymbol } from '../../shared/types'

/**
 * Model Explorer: the map as a searchable outline - systems, files, symbols -
 * for large maps and for keyboard and screen-reader use. Selecting a row
 * selects and frames its node; selecting on the canvas reveals its row.
 */
export function ModelExplorer({ onClose }: { onClose: () => void }) {
  const systems = useGraphStore(s => s.systems)
  const files = useGraphStore(s => s.files)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const selectedNodeId = useGraphStore(s => s.selectedNodeId)
  const setSelectedNode = useGraphStore(s => s.setSelectedNode)
  const toggleSystemExpanded = useGraphStore(s => s.toggleSystemExpanded)
  const expandedSystemIds = useGraphStore(s => s.expandedSystemIds)
  const { fitView } = useReactFlow()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [symbols, setSymbols] = useState<Map<string, DbSymbol[]>>(() => new Map())
  const [activeId, setActiveId] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(
    () => buildOutline({ systems, files, symbols, expanded, query }),
    [systems, files, symbols, expanded, query],
  )

  const loadSymbols = (fileId: string) => {
    if (!workspaceId || symbols.has(fileId)) return
    void fetchFileSymbols(workspaceId, fileId)
      .then(list => setSymbols(current => new Map(current).set(fileId, list as DbSymbol[])))
      .catch(() => setSymbols(current => new Map(current).set(fileId, [])))
  }

  const toggle = (row: OutlineRow, open = !row.expanded) => {
    if (!row.expandable) return
    if (open && row.kind === 'file') loadSymbols(row.id)
    setExpanded(current => {
      const next = new Set(current)
      if (open) next.add(row.id)
      else next.delete(row.id)
      return next
    })
  }

  const select = (row: OutlineRow) => {
    setActiveId(row.id)
    if (!row.nodeId) { toggle(row); return }
    const file = files.find(candidate => candidate.id === row.nodeId)
    if (file?.systemId && !expandedSystemIds.has(file.systemId)) toggleSystemExpanded(file.systemId)
    setSelectedNode(row.nodeId)
    setTimeout(() => { void fitView({ nodes: [{ id: row.nodeId! }], duration: 600, padding: 0.5, maxZoom: 1.4 }) }, 50)
  }

  // Selecting on the canvas opens the path to that node's row.
  useEffect(() => {
    if (!selectedNodeId) return
    const parentOf = new Map(systems.map(system => [system.id, system.parentId]))
    const file = files.find(candidate => candidate.id === selectedNodeId)
    const path: string[] = []
    let current: string | null | undefined = file ? (file.systemId ?? UNSORTED_ID) : parentOf.get(selectedNodeId)
    for (let hops = 0; current && hops < 64; hops++) {
      path.push(current)
      current = current === UNSORTED_ID ? null : parentOf.get(current)
    }
    if (path.length > 0) setExpanded(prev => (path.every(id => prev.has(id)) ? prev : new Set([...prev, ...path])))
    setActiveId(selectedNodeId)
  }, [selectedNodeId, systems, files])

  useEffect(() => {
    if (!activeId) return
    treeRef.current?.querySelector(`[data-row-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId, rows])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, rows.findIndex(row => row.id === activeId))
    const row = rows[index]
    const move = (to: number) => { event.preventDefault(); const next = rows[Math.min(rows.length - 1, Math.max(0, to))]; if (next) setActiveId(next.id) }
    switch (event.key) {
      case 'ArrowDown': move(index + 1); break
      case 'ArrowUp': move(index - 1); break
      case 'Home': move(0); break
      case 'End': move(rows.length - 1); break
      case 'ArrowRight':
        event.preventDefault()
        if (row?.expandable && !row.expanded) toggle(row, true)
        else move(index + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (row?.expanded) toggle(row, false)
        else {
          for (let i = index - 1; i >= 0; i--) if (rows[i].depth < (row?.depth ?? 0)) { setActiveId(rows[i].id); break }
        }
        break
      case 'Enter':
      case ' ':
        if (row) { event.preventDefault(); select(row) }
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
    }
  }

  return (
    <aside className="axiom-explorer" aria-label="Model Explorer">
      <header className="axiom-explorer__header">
        <strong>Model Explorer</strong>
        <button type="button" aria-label="Close Model Explorer" onClick={onClose}>×</button>
      </header>
      <input
        className="axiom-explorer__search"
        type="search"
        aria-label="Filter systems, files and symbols"
        placeholder="Filter systems, files, symbols…"
        value={query}
        autoFocus
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActiveId(rows[0]?.id ?? null); treeRef.current?.focus() }
          if (event.key === 'Escape') onClose()
        }}
      />
      <div ref={treeRef} className="axiom-explorer__tree" role="tree" aria-label="Systems, files and symbols" tabIndex={0} onKeyDown={onKeyDown}>
        {rows.length === 0 && <p className="axiom-explorer__empty">{query ? 'Nothing matches.' : 'The map is empty.'}</p>}
        {rows.map(row => (
          <div
            key={row.id}
            data-row-id={row.id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.expandable ? row.expanded : undefined}
            aria-selected={row.nodeId !== null && row.nodeId === selectedNodeId && row.kind !== 'symbol'}
            className="axiom-explorer__row"
            data-kind={row.kind}
            data-active={row.id === activeId ? 'true' : undefined}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            onClick={() => select(row)}
          >
            <span
              className="axiom-explorer__twisty"
              aria-hidden="true"
              onClick={event => { event.stopPropagation(); toggle(row) }}
            >
              {row.expandable ? (row.expanded ? '▾' : '▸') : ''}
            </span>
            <span className="axiom-explorer__label" title={row.detail && row.kind === 'file' ? row.detail : row.label}>{row.label}</span>
            {row.detail && row.kind !== 'file' && <small>{row.detail}</small>}
          </div>
        ))}
      </div>
    </aside>
  )
}
