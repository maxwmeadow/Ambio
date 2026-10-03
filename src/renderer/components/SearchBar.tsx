import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'
import { searchSymbols } from '../canvas/symbolSearch'
import { buildSearchResults, SEARCH_GROUP_LABELS, type SearchResult, type SymbolMatch } from '../canvas/searchResults'
import { SourcePreviewDialog } from './SourcePreviewDialog'
import type { DbSymbol } from '../../shared/types'

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
 * ⌘K: find anything on the map by name - systems, infrastructure, files, and
 * symbols from archd's index - and jump to it. A symbol frames its file and
 * opens the source at its lines.
 */
export function SearchBar({ onClose }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [symbols, setSymbols] = useState<SymbolMatch[]>([])
  const [preview, setPreview] = useState<SymbolMatch | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeResultRef = useRef<HTMLButtonElement>(null)
  const { fitView } = useReactFlow()
  const files = useGraphStore(s => s.files)
  const systems = useGraphStore(s => s.systems)
  const infraNodes = useGraphStore(s => s.infraNodes)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const setSelectedNode = useGraphStore(s => s.setSelectedNode)
  const toggleSystemExpanded = useGraphStore(s => s.toggleSystemExpanded)
  const expandedSystemIds = useGraphStore(s => s.expandedSystemIds)

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
    () => buildSearchResults({ query, systems, infraNodes, files, symbols }),
    [query, systems, infraNodes, files, symbols],
  )

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
    const file = result.kind === 'file' ? result.file
      : result.kind === 'symbol' ? files.find(candidate => candidate.id === result.nodeId)
      : undefined
    if (file?.systemId && !expandedSystemIds.has(file.systemId)) {
      toggleSystemExpanded(file.systemId)
    }
    setSelectedNode(result.nodeId)
    setTimeout(() => {
      fitView({ nodes: [{ id: result.nodeId }], duration: 850, padding: 0.5 })
    }, 50)
    if (result.kind === 'symbol') setPreview(result.symbol)
    else onClose()
  }, [files, setSelectedNode, toggleSystemExpanded, expandedSystemIds, fitView, onClose])

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

  if (preview) {
    return (
      <SourcePreviewDialog
        fileId={preview.fileId}
        workspaceId={workspaceId}
        symbol={{ name: preview.name, kind: preview.kind as DbSymbol['kind'], lineStart: preview.lineStart, lineEnd: preview.lineEnd }}
        onClose={onClose}
      />
    )
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
          <div>
            <h2>Find in project</h2>
            <p>Systems, infrastructure, files and symbols</p>
          </div>
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
            placeholder="A system, file, path or function name…"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="ambio-search-body">
          {results.length > 0 && (
            <>
              <div className="ambio-search-results-header">
                <span>Results</span>
                <output>{results.length} {results.length === 1 ? 'match' : 'matches'}</output>
              </div>
              <div className="ambio-search-results" id="ambio-search-results" role="listbox" aria-label="Search results">
                {results.map((result, index) => {
                  const active = index === activeIdx
                  const systemName = result.kind === 'file' && result.file.systemId ? systemNames.get(result.file.systemId) : null
                  const badge = result.kind === 'file' ? result.file.language
                    : result.kind === 'symbol' ? result.symbol.kind
                    : result.kind === 'infra' ? 'infra' : 'system'
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

          {query && results.length === 0 && (
            <div className="ambio-search-empty">
              <strong>No matches</strong>
              <span>No system, file or symbol is named like “{query}”.</span>
            </div>
          )}

          {!query && (
            <div className="ambio-search-empty ambio-search-empty--idle">
              <strong>Search the project index</strong>
              <span>Start with a system, a filename or path fragment, or a function or class name.</span>
            </div>
          )}
        </div>

        <footer className="ambio-search-footer" aria-label="Search keyboard shortcuts">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><kbd>Enter</kbd> show on canvas</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
