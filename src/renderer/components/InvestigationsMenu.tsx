import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGraphStore, type InvestigationDoc } from '../store/graphStore'
import {
  apiDeleteInvestigation,
  apiGetInvestigation,
  apiListInvestigations,
  type InvestigationMeta,
} from '../canvas/arcdApi'
import { archdApi } from '../archdEndpoint.ts'
import { useCommandHandlers } from '../app/commands'

const MENU_WIDTH = 360

/** What a run can see for one language here (docs/INVESTIGATION_RUNTIMES.md). */
interface LanguageReadiness {
  language: string
  files: number
  level: 'full' | 'output' | 'missing'
  tool?: string
  version?: string
  note: string
}

const LEVEL_LABEL: Record<LanguageReadiness['level'], string> = {
  full: 'Full detail',
  output: 'Output only',
  missing: 'Not installed',
}
const VIEWPORT_GUTTER = 8

function captureDate(createdAt: number): string {
  if (!createdAt) return 'Date unavailable'
  return new Date(createdAt).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function InvestigationsMenu({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLElement>(null)
  const [items, setItems] = useState<InvestigationMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [readiness, setReadiness] = useState<LanguageReadiness[]>([])
  const startReplay = useGraphStore(state => state.startReplay)

  const updatePosition = useCallback(() => {
    const left = Math.max(
      VIEWPORT_GUTTER,
      (window.innerWidth - MENU_WIDTH) / 2,
    )
    setPosition({ left, top: 88 })
  }, [])

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    // What runs can see in this project; the list works without it.
    void fetch(`${archdApi()}/api/investigation/readiness?workspace=${encodeURIComponent(workspaceId)}`)
      .then(response => response.ok ? response.json() : { languages: [] })
      .then((payload: { languages?: LanguageReadiness[] }) => setReadiness(payload.languages ?? []))
      .catch(() => setReadiness([]))
    try {
      const payload = await apiListInvestigations(workspaceId)
      setItems(payload.investigations)
    } catch (cause: unknown) {
      setItems([])
      setError(cause instanceof Error ? cause.message : 'Unable to load investigation captures')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    updatePosition()
    setOpen(true)
    void load()
  }
  useCommandHandlers({ 'investigation.browse': toggle })

  const remove = async (id: string) => {
    setError(null)
    try {
      await apiDeleteInvestigation(workspaceId, id)
      setItems(current => current.filter(item => item.id !== id))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete capture')
    }
  }

  const openReplay = async (id: string) => {
    setOpeningId(id)
    setError(null)
    try {
      startReplay(await apiGetInvestigation(workspaceId, id) as InvestigationDoc)
      setOpen(false)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to open investigation capture')
    } finally {
      setOpeningId(null)
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    menuRef.current?.focus()
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  useEffect(() => {
    setOpen(false)
    setItems([])
    setError(null)
  }, [workspaceId])

  return (
    <>
      {open && createPortal(
        <>
          <div className="ambio-investigations-scrim" onPointerDown={() => setOpen(false)} />
          <section
            ref={menuRef}
            tabIndex={-1}
            className="ambio-investigations-menu"
            id="ambio-investigations-menu"
            role="menu"
            aria-label="Investigation captures"
            style={{
              '--ambio-investigations-left': `${position.left}px`,
              '--ambio-investigations-top': `${position.top}px`,
            } as React.CSSProperties}
          >
            <header className="ambio-investigations-menu__header">
              <div>
                <h2>Investigation captures</h2>
                <p>Agent investigations, ready to replay</p>
              </div>
              {!loading && !error && <output>{items.length}</output>}
            </header>

            <div className="ambio-investigations-menu__body">
              {loading && <div className="ambio-investigations-menu__state">Loading captures…</div>}
              {error && <div className="ambio-investigations-menu__state ambio-investigations-menu__state--error" role="alert">{error}</div>}
              {!loading && !error && items.length === 0 && (
                <div className="ambio-investigations-menu__empty">
                  <strong>No captures yet</strong>
                  <span>
                    Start a recording from Tools, or ask your agent to investigate a problem. Saved recordings appear here.
                  </span>
                </div>
              )}
              {!loading && items.map(investigation => (
                <div className="ambio-investigations-menu__row" key={investigation.id}>
                <button
                  type="button"
                  className="ambio-investigations-menu__item"
                  role="menuitem"
                  disabled={openingId !== null}
                  onClick={() => void openReplay(investigation.id)}
                >
                  <span className="ambio-investigations-menu__item-title">
                    <strong>{investigation.name}</strong>
                    <time dateTime={new Date(investigation.createdAt).toISOString()}>
                      {captureDate(investigation.createdAt)}
                    </time>
                  </span>
                  <span className="ambio-investigations-menu__item-meta">
                    <span>{investigation.eventCount} events</span>
                    <span>{(investigation.durationMs / 1000).toFixed(1)}s</span>
                    {investigation.commit
                      ? <code>{investigation.branch}@{investigation.commit.slice(0, 7)}</code>
                      : <code title="Ambio could not resolve a git commit, so this capture is not pinned to a code version.">no commit</code>}
                    {investigation.origin === 'auto' && (
                      <span
                        className="ambio-investigations-menu__flag ambio-investigations-menu__flag--auto"
                        title="Ambio started this recording when it saw the agent begin investigating."
                      >
                        auto
                      </span>
                    )}
                    {investigation.status === 'interrupted' && (
                      <span
                        className="ambio-investigations-menu__flag"
                        title="Recording never stopped - Ambio saved what it had captured up to that point."
                      >
                        interrupted
                      </span>
                    )}
                  </span>
                  {openingId === investigation.id && <span className="ambio-investigations-menu__opening">Opening…</span>}
                </button>
                <button
                  type="button"
                  className="ambio-investigations-menu__delete"
                  aria-label={`Delete ${investigation.name}`}
                  title="Delete this capture"
                  onClick={event => { event.stopPropagation(); void remove(investigation.id) }}
                >
                  ×
                </button>
                </div>
              ))}
            </div>
            {readiness.length > 0 && (
              <footer className="ambio-investigations-menu__readiness" aria-label="What runs can see in this project">
                <h3>What runs can see here</h3>
                <ul>
                  {readiness.map(row => (
                    <li key={row.language} title={[row.version, row.note].filter(Boolean).join(' - ')}>
                      <span className="ambio-investigations-menu__readiness-language">{row.language}</span>
                      <span className="ambio-investigations-menu__readiness-level" data-level={row.level}>
                        {LEVEL_LABEL[row.level]}
                      </span>
                    </li>
                  ))}
                </ul>
                {readiness.some(row => row.level !== 'full') && (
                  <p>
                    {readiness.filter(row => row.level !== 'full').map(row => `${row.language}: ${row.note}.`).join(' ')}
                  </p>
                )}
              </footer>
            )}
          </section>
        </>,
        document.body,
      )}
    </>
  )
}
