import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShowOnMap } from '../canvas/useShowOnMap'
import { useGraphStore } from '../store/graphStore'
import { searchSymbols } from '../canvas/symbolSearch'
import {
  buildSearchResults, SEARCH_GROUP_LABELS, searchResultBadge,
  type SearchInvestigation, type SearchNote, type SearchPlanned, type SearchResult, type SymbolMatch,
} from '../canvas/searchResults'
import { useSourcePreviewStore } from '../store/sourcePreviewStore'
import { fetchSheetLayer, useSheetStore } from '../store/sheetStore'
import { useConversationPreferences } from '../store/conversationPreferences'
import { conversations as threadsOf, turnRequest } from './inboxModel'
import { apiGetInvestigation, apiListInvestigations } from '../canvas/arcdApi'
import type { InvestigationDoc } from '../store/graphStore'

interface SearchBarProps {
  onClose: () => void
}

function HighlightedMatch({ query, text }: { query: string; text: string }) {
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase())
  if (index < 0 || !query.trim()) return <>{text}</>

  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.trim().length)}</mark>
      {text.slice(index + query.trim().length)}
    </>
  )
}

/**
 * ⌘K: find anything Ambio keeps - systems, infrastructure, files, functions
 * and classes from archd's index, sheets, what is drawn on them, sticky notes,
 * agent conversations and saved investigations - and go to it. A symbol frames
 * its file and opens the source at its lines; a sheet opens; a drawn item or
 * note opens its sheet and is shown; a conversation opens in the agent panel;
 * an investigation starts its replay.
 */
export function SearchBar({ onClose }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [symbols, setSymbols] = useState<SymbolMatch[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const activeResultRef = useRef<HTMLButtonElement>(null)
  const showOnMap = useShowOnMap(false)
  const files = useGraphStore(s => s.files)
  const systems = useGraphStore(s => s.systems)
  const infraNodes = useGraphStore(s => s.infraNodes)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const startReplay = useGraphStore(s => s.startReplay)
  const allSheets = useSheetStore(s => s.sheets)
  const floorNotes = useSheetStore(s => s.floorNotes)
  const messages = useSheetStore(s => s.messages)
  const sheets = useMemo(() => allSheets.filter(sheet => !sheet.resolvedAt), [allSheets])
  // What is on each sheet and saved investigations are not kept in the
  // stores; read them once when the window opens.
  const [onSheets, setOnSheets] = useState<{ planned: SearchPlanned[]; notes: SearchNote[] }>({ planned: [], notes: [] })
  const [investigations, setInvestigations] = useState<SearchInvestigation[]>([])
  const sheetIds = sheets.map(sheet => sheet.id).join('|')
  useEffect(() => {
    if (!workspaceId) return
    let active = true
    const named = new Map(sheets.map(sheet => [sheet.id, sheet.name]))
    void Promise.all(sheets.map(sheet => fetchSheetLayer(workspaceId, sheet.id).catch(() => null))).then(layers => {
      if (!active) return
      const planned: SearchPlanned[] = [], notes: SearchNote[] = []
      for (const layer of layers) {
        if (!layer) continue
        const sheetName = named.get(layer.sheet.id) ?? layer.sheet.name
        for (const node of layer.planned) planned.push({ id: node.id, sheetId: layer.sheet.id, sheetName, name: node.name, kind: node.kind })
        for (const note of layer.annotations) if (note.kind === 'note') notes.push({ id: note.id, sheetId: layer.sheet.id, sheetName, body: note.body })
      }
      setOnSheets({ planned, notes })
    })
    apiListInvestigations(workspaceId)
      .then(list => { if (active) setInvestigations(list.investigations.filter(item => item.status !== 'recording').map(item => ({ id: item.id, name: item.name, createdAt: item.createdAt }))) })
      .catch(() => {})
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sheetIds])
  const notes = useMemo<SearchNote[]>(() => [
    ...floorNotes.filter(note => note.kind === 'note').map(note => ({ id: note.id, sheetId: null, sheetName: null, body: note.body })),
    ...onSheets.notes,
  ], [floorNotes, onSheets.notes])
  // A conversation is found by what the person asked and what the agent said.
  const conversationIndex = useMemo(() => threadsOf(messages.filter(message => message.workspaceId === workspaceId)).map(thread => ({
    id: thread.id, title: thread.title, turns: thread.turns.length,
    said: thread.turns.flatMap(turn => [turnRequest(turn).text, ...(turn.reply?.body ? [turn.reply.body] : [])]),
  })), [messages, workspaceId])

  // Symbols live in archd, not the store: ask after a short pause in typing.
  useEffect(() => {
    const q = query.trim()
    if (!q || !workspaceId) { setSymbols([]); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchSymbols(workspaceId, q, controller.signal)
        .then(setSymbols)
        .catch(() => { if (!controller.signal.aborted) setSymbols([]) })
    }, 120)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, workspaceId])

  const results = useMemo(
    () => buildSearchResults({
      query, systems, infraNodes, files, symbols,
      sheets, planned: onSheets.planned, notes, conversations: conversationIndex, investigations,
    }),
    [query, systems, infraNodes, files, symbols, sheets, onSheets.planned, notes, conversationIndex, investigations],
  )

  const browsing = !query.trim()

  const systemNames = useMemo(
    () => new Map(systems.map(system => [system.id, system.name])),
    [systems],
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    activeResultRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const navigate = useCallback((result: SearchResult) => {
    onClose()
    const sheetsNow = useSheetStore.getState()
    switch (result.kind) {
      case 'sheet':
        void sheetsNow.openSheet(workspaceId, result.sheetId, { exclusive: true })
        return
      case 'planned':
      case 'note':
        // Its surface first, then the canvas can find and frame it.
        if (sheetsNow.activeSheetId !== result.sheetId) void sheetsNow.openSheet(workspaceId, result.sheetId, result.sheetId ? { exclusive: true } : undefined)
        showOnMap(result.nodeId)
        return
      case 'conversation':
        useConversationPreferences.setState({ requested: { workspaceId, threadId: result.threadId } })
        return
      case 'investigation':
        void apiGetInvestigation(workspaceId, result.investigationId).then(doc => startReplay(doc as InvestigationDoc)).catch(() => {})
        return
    }
    showOnMap(result.nodeId)
    if (result.kind === 'symbol') {
      const { fileId, name, kind, lineStart, lineEnd } = result.symbol
      useSourcePreviewStore.getState().open({ fileId, workspaceId, name, kind, lineStart, lineEnd })
    }
  }, [showOnMap, onClose, workspaceId, startReplay])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (results.length > 0) setActiveIdx(index => Math.min(index + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length > 0) setActiveIdx(index => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && results[activeIdx]) {
      event.preventDefault()
      navigate(results[activeIdx])
    } else if (event.key === 'Escape') {
      onClose()
    }
  }

  return createPortal(
    <div
      className="ambio-search-backdrop nodrag nopan nowheel"
      role="presentation"
      onPointerDown={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onWheel={event => event.stopPropagation()}
    >
      <section className="ambio-search-window" role="dialog" aria-modal="true" aria-label="Search the map">
        <header className="ambio-search-header">
          <h2>Find in project</h2>
          <button type="button" className="ambio-search-close" onClick={onClose} aria-label="Close search">×</button>
        </header>

        <div className="ambio-search-query">
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            aria-activedescendant={results[activeIdx] ? `ambio-search-result-${results[activeIdx].id}` : undefined}
            aria-controls="ambio-search-results"
            aria-label="Search the map"
            autoComplete="off"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search systems, files, functions, sheets, notes, conversations…"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="ambio-search-body">
          {results.length > 0 && (
            <>
              <div className="ambio-search-results" id="ambio-search-results" role="listbox" aria-label="Search results">
                {results.map((result, index) => {
                  const active = index === activeIdx
                  const systemName = result.kind === 'file' && result.file.systemId ? systemNames.get(result.file.systemId) : null
                  const badge = searchResultBadge(result)
                  return (
                    <React.Fragment key={result.id}>
                      {(index === 0 || results[index - 1].kind !== result.kind) && (
                        <div className="ambio-search-group" role="presentation">{SEARCH_GROUP_LABELS[result.kind]}</div>
                      )}
                      <button
                        ref={active ? activeResultRef : undefined}
                        id={`ambio-search-result-${result.id}`}
                        type="button"
                        className="ambio-search-result"
                        data-kind={result.kind}
                        aria-selected={active}
                        role="option"
                        onClick={() => navigate(result)}
                        onMouseEnter={() => setActiveIdx(index)}
                      >
                        <span className="ambio-search-result__icon" aria-hidden="true" />
                        <span className="ambio-search-result__copy">
                          <strong><HighlightedMatch query={query} text={result.title} /></strong>
                          <span><HighlightedMatch query={query} text={result.detail} /></span>
                        </span>
                        {systemName && <span className="ambio-search-result__system">{systemName}</span>}
                        <span className="ambio-search-result__language">{badge}</span>
                      </button>
                    </React.Fragment>
                  )
                })}
              </div>
            </>
          )}

          {!browsing && results.length === 0 && (
            <div className="ambio-search-empty">
              <strong>No matches</strong>
              <span>Nothing in this project matches “{query}”.</span>
            </div>
          )}

          {browsing && results.length === 0 && (
            <div className="ambio-search-empty ambio-search-empty--idle">
              <strong>Search the project index</strong>
              <span>Start with a system, a filename or path fragment, or a function or class name.</span>
            </div>
          )}
        </div>

        <footer className="ambio-search-footer" aria-label="Search keyboard shortcuts">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
