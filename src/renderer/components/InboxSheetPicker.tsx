import React, { useEffect, useMemo, useState } from 'react'
import type { Sheet } from '../store/sheetStore'
import { useGraphStore } from '../store/graphStore'
import { searchSymbols } from '../canvas/symbolSearch'
import { buildSearchResults, SEARCH_GROUP_LABELS, type SearchResult, type SymbolMatch } from '../canvas/searchResults'
import { canvasReference, codeReference } from './inboxModel'
import { InboxIcon } from './InboxIcon'

/** What can be attached as context: things on the map and the sheets that plan them. */
const ATTACHABLE = new Set<SearchResult['kind']>(['sheet', 'system', 'infra', 'file', 'symbol'])

/** The reference a result attaches as, or the sheet it attaches. */
export function attachmentFor(result: SearchResult): { sheetId: string } | { reference: string } | null {
  switch (result.kind) {
    case 'sheet': return { sheetId: result.sheetId }
    case 'system': return { reference: canvasReference('system', result.id, result.title) }
    case 'infra': return { reference: canvasReference('infra', result.id, result.title) }
    case 'file': return { reference: codeReference(result.file.id, result.file.relPath) }
    case 'symbol': return { reference: codeReference(result.symbol.fileId, result.symbol.relPath, { start: result.symbol.lineStart, end: result.symbol.lineEnd }) }
  }
  return null
}

const ICONS: Partial<Record<SearchResult['kind'], React.ComponentProps<typeof InboxIcon>['name']>> = {
  sheet: 'sheet', system: 'system', infra: 'infra', file: 'file', symbol: 'symbol',
}

/**
 * Attach context to the next message: a sheet, or any system, infrastructure,
 * file, function or class, found the way Find in project finds them.
 */
export function InboxSheetPicker({ sheets, attachedId, attachedRefs, onSelect, onAttach, onFromComputer, onClose }: {
  sheets: Sheet[]
  attachedId: string | null
  /** References already going with the message, so they show as attached. */
  attachedRefs: readonly string[]
  onSelect: (sheetId: string) => void
  onAttach: (reference: string) => void
  /** Files or a folder from this computer, chosen in the system dialog. */
  onFromComputer?: (kind: 'files' | 'folder') => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [symbols, setSymbols] = useState<SymbolMatch[]>([])
  const systems = useGraphStore(s => s.systems)
  const files = useGraphStore(s => s.files)
  const infraNodes = useGraphStore(s => s.infraNodes)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')

  // Functions and classes live in archd's index: ask after a short pause in typing.
  useEffect(() => {
    const q = query.trim()
    if (!q || !workspaceId) { setSymbols([]); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchSymbols(workspaceId, q, controller.signal).then(setSymbols).catch(() => { if (!controller.signal.aborted) setSymbols([]) })
    }, 120)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, workspaceId])

  const openSheets = useMemo(() => sheets.filter(sheet => !sheet.resolvedAt), [sheets])
  const matches = useMemo(() => {
    const results = buildSearchResults({ query, systems, infraNodes, files, symbols, sheets: openSheets }).filter(result => ATTACHABLE.has(result.kind))
    // Sheets first: a sheet is the fullest context there is.
    return [...results.filter(result => result.kind === 'sheet'), ...results.filter(result => result.kind !== 'sheet')]
  }, [query, systems, infraNodes, files, symbols, openSheets])
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, matches.length - 1))) }, [matches.length])

  const attached = (result: SearchResult) => {
    const target = attachmentFor(result)
    if (!target) return false
    return 'sheetId' in target ? target.sheetId === attachedId : attachedRefs.includes(target.reference)
  }
  const choose = (result: SearchResult) => {
    const target = attachmentFor(result)
    if (!target) return
    if ('sheetId' in target) onSelect(target.sheetId)
    else onAttach(target.reference)
  }

  return <div className="ambio-inbox__picker" role="dialog" aria-label="Attach context" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <div className="ambio-inbox__search"><InboxIcon name="search" /><input autoFocus role="combobox" aria-label="Search for context to attach" aria-expanded="true" aria-controls="inbox-context-options" aria-autocomplete="list" aria-activedescendant={matches[active] ? `inbox-context-option-${active}` : undefined}
      placeholder="Sheet, system, file or function…" value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = matches.length ? (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0
          setActive(next); document.getElementById(`inbox-context-option-${next}`)?.scrollIntoView({ block: 'nearest' })
        }
        if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) choose(matches[active]) }
      }} /><button type="button" className="ambio-inbox__icon" aria-label="Close" onClick={onClose}><InboxIcon name="close" size={14} /></button></div>
    <div id="inbox-context-options" role="listbox" aria-label="Context to attach">
      {matches.map((result, index) => <React.Fragment key={result.id}>
        {(index === 0 || matches[index - 1].kind !== result.kind) && <div className="ambio-inbox__picker-label" role="presentation">{SEARCH_GROUP_LABELS[result.kind]}</div>}
        <button type="button" role="option" aria-selected={active === index} id={`inbox-context-option-${index}`} tabIndex={-1} data-kind={result.kind}
          onMouseEnter={() => setActive(index)} onClick={() => choose(result)}>
          <span className="ambio-inbox__sheet-icon"><InboxIcon name={ICONS[result.kind] ?? 'canvas'} size={16} /></span>
          <span><strong>{result.title}</strong>{result.detail && <small>{result.detail}</small>}</span>
          {attached(result) && <InboxIcon name="check" size={15} />}
        </button>
      </React.Fragment>)}
      {!matches.length && <p className="ambio-inbox__picker-empty">{query.trim() ? 'Nothing matches.' : 'Nothing to attach yet.'}</p>}
    </div>
    {onFromComputer && <div className="ambio-inbox__picker-computer">
      <span>From this computer</span>
      <button type="button" onClick={() => onFromComputer('files')}><InboxIcon name="file" size={13} />Files…</button>
      <button type="button" onClick={() => onFromComputer('folder')}><InboxIcon name="folder" size={13} />Folder…</button>
    </div>}
  </div>
}
