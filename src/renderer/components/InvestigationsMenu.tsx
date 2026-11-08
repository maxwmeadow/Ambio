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
import { emitCommand, useCommandHandlers } from '../app/commands'
import { InfoPopover } from './ui/InfoPopover'
import { ChromeButton } from './ui/ChromeButton'

const MENU_WIDTH = 380
const VIEWPORT_GUTTER = 8
const TOOLBAR_GAP = 6

/** What a run can see for one language here (docs/INVESTIGATION_RUNTIMES.md). */
interface LanguageReadiness {
  language: string
  files: number
  level: 'full' | 'output' | 'missing'
  tool?: string
  version?: string
  note: string
  /** The command that installs this language's toolchain on this computer. */
  install?: string
}

const LEVEL_LABEL: Record<LanguageReadiness['level'], string> = {
  full: 'records calls',
  output: 'output only',
  missing: 'not installed',
}

function captureDate(createdAt: number): string {
  if (!createdAt) return 'No date'
  const date = new Date(createdAt)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  })
}

function captureDuration(durationMs: number): string {
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

/**
 * Saved investigations: replay, delete, and what runs can record here. Opened
 * by `investigation.browse`; with `trigger` it also renders its toolbar
 * button and hangs from it.
 */
export function InvestigationsMenu({ workspaceId, trigger = false }: { workspaceId: string; trigger?: boolean }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLElement>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [items, setItems] = useState<InvestigationMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [readiness, setReadiness] = useState<LanguageReadiness[]>([])
  const startReplay = useGraphStore(state => state.startReplay)

  // Hang from the toolbar button when there is one, else centre under the
  // toolbar; either way the popover never covers the chrome that opened it.
  const updatePosition = useCallback(() => {
    const toolbar = document.querySelector('.ambio-toolbar')?.getBoundingClientRect()
    const anchor = anchorRef.current?.getBoundingClientRect()
    const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2)
    const preferred = anchor && anchor.width > 0 ? anchor.left : (window.innerWidth - width) / 2
    const left = Math.max(VIEWPORT_GUTTER, Math.min(preferred, window.innerWidth - width - VIEWPORT_GUTTER))
    setPosition({ left, top: (toolbar?.bottom ?? 82) + TOOLBAR_GAP })
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
      setItems([...payload.investigations].sort((a, b) => b.createdAt - a.createdAt))
    } catch (cause: unknown) {
      setItems([])
      setError(cause instanceof Error ? cause.message : 'Unable to load saved investigations')
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
      setError(cause instanceof Error ? cause.message : 'Unable to delete this investigation')
    }
  }

  const openReplay = async (id: string) => {
    setOpeningId(id)
    setError(null)
    try {
      startReplay(await apiGetInvestigation(workspaceId, id) as InvestigationDoc)
      setOpen(false)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to open this investigation')
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

  const needsSetup = readiness.filter(row => row.level !== 'full')

  return (
    <>
      {trigger && (
        <span ref={anchorRef} className="ambio-investigations-anchor">
          <ChromeButtonTrigger open={open} />
        </span>
      )}
      {open && createPortal(
        <>
          <div className="ambio-investigations-scrim" onPointerDown={() => setOpen(false)} />
          <section
            ref={menuRef}
            tabIndex={-1}
            className="ambio-investigations-menu"
            id="ambio-investigations-menu"
            role="dialog"
            aria-label="Saved investigations"
            style={{
              '--ambio-investigations-left': `${position.left}px`,
              '--ambio-investigations-top': `${position.top}px`,
            } as React.CSSProperties}
          >
            <header className="ambio-investigations-menu__header">
              <h2>Saved investigations</h2>
              {!loading && !error && items.length > 0 && (
                <span className="ambio-investigations-menu__count" aria-label={`${items.length} saved`}>{items.length}</span>
              )}
              <InfoPopover
                className="ambio-investigations-menu__info"
                beside=".ambio-investigations-menu"
                label="How investigations work"
                title="How investigations work"
              >
                <p>
                  Investigations let your agent debug by running your code instead of reasoning about it in its
                  head. It writes a repro (a test, a script that calls any function with inputs it chooses, or a
                  request to your server), runs it, and watches the functions it suspects: each call&apos;s
                  arguments, return value, errors and what changed.
                </p>
                <p>
                  Each run tests one suspicion, so the root cause it reports rests on what actually happened. You
                  watch the case build beside the map and can message the agent while it works.
                </p>
                <p>
                  Ask your agent to investigate a problem, or record a run yourself from{' '}
                  <strong>Tools ▸ Start / Stop Recording</strong>. Every run is saved here; open one to replay it
                  on the map, step by step.
                </p>
                <p>
                  Runs record each function call in JavaScript/TypeScript, Python, Ruby, Java, Kotlin, Scala,
                  C#, Go, Rust and PHP. C and C++ get the same detail through gdb or lldb. The bar at the bottom
                  shows the languages this project uses and whether each is ready on this computer.
                </p>
                {needsSetup.length > 0 && (
                  <ul className="ambio-investigations-menu__help-list">
                    {needsSetup.map(row => (
                      <li key={row.language}>
                        <strong>{row.language}</strong>
                        {row.level === 'missing'
                          ? <> is not installed on this computer, so runs cannot start it.
                            {row.install && <> Install it with <code>{row.install}</code>, then reopen this list.</>}</>
                          : <> runs show their output and exit code, but not each function call.</>}
                      </li>
                    ))}
                  </ul>
                )}
              </InfoPopover>
            </header>

            <div className="ambio-investigations-menu__body">
              {loading && <div className="ambio-investigations-menu__state">Loading…</div>}
              {error && <div className="ambio-investigations-menu__state ambio-investigations-menu__state--error" role="alert">{error}</div>}
              {!loading && !error && items.length === 0 && (
                <div className="ambio-investigations-menu__empty">
                  <strong>No saved investigations yet</strong>
                  <span>Record one from Tools, or ask your agent to investigate a problem.</span>
                </div>
              )}
              {!loading && items.length > 0 && (
                <ul className="ambio-investigations-menu__list">
                  {items.map(investigation => (
                    <li className="ambio-investigations-menu__row" key={investigation.id}>
                      <button
                        type="button"
                        className="ambio-investigations-menu__item"
                        disabled={openingId !== null}
                        aria-busy={openingId === investigation.id || undefined}
                        onClick={() => void openReplay(investigation.id)}
                      >
                        <span className="ambio-investigations-menu__item-title">
                          <strong title={investigation.name}>{investigation.name}</strong>
                          {investigation.status === 'interrupted' && (
                            <span
                              className="ambio-investigations-menu__flag"
                              title="The recording never stopped; Ambio kept what it had captured."
                            >
                              Interrupted
                            </span>
                          )}
                          {investigation.origin === 'auto' && (
                            <span
                              className="ambio-investigations-menu__flag ambio-investigations-menu__flag--auto"
                              title="Ambio started this recording when the agent began investigating."
                            >
                              Auto
                            </span>
                          )}
                        </span>
                        <span className="ambio-investigations-menu__item-meta">
                          <time dateTime={investigation.createdAt ? new Date(investigation.createdAt).toISOString() : undefined}>
                            {captureDate(investigation.createdAt)}
                          </time>
                          <span>{investigation.eventCount} {investigation.eventCount === 1 ? 'event' : 'events'}</span>
                          <span>{captureDuration(investigation.durationMs)}</span>
                          {investigation.commit && (
                            <code title={`${investigation.branch}@${investigation.commit}`}>
                              {investigation.branch ? `${investigation.branch}@` : ''}{investigation.commit.slice(0, 7)}
                            </code>
                          )}
                        </span>
                        {openingId === investigation.id && <span className="ambio-investigations-menu__opening">Opening…</span>}
                      </button>
                      <button
                        type="button"
                        className="ambio-investigations-menu__delete"
                        aria-label={`Delete ${investigation.name}`}
                        title="Delete"
                        onClick={event => { event.stopPropagation(); void remove(investigation.id) }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {readiness.length > 0 && (
              <footer className="ambio-investigations-menu__languages" aria-label="This project's languages">
                <span className="ambio-investigations-menu__languages-label">This project</span>
                {readiness.map(row => (
                  <span
                    key={row.language}
                    className="ambio-investigations-menu__language"
                    data-level={row.level}
                    title={`${row.language}: ${LEVEL_LABEL[row.level]}`}
                  >
                    {row.language.replace(/\s*\(.*\)$/, '')}
                    {row.level !== 'full' && <em>{LEVEL_LABEL[row.level]}</em>}
                  </span>
                ))}
              </footer>
            )}
          </section>
        </>,
        document.body,
      )}
    </>
  )
}

function ChromeButtonTrigger({ open }: { open: boolean }) {
  return (
    <ChromeButton
      onClick={() => emitCommand('investigation.browse')}
      label="Investigations"
      active={open}
      ariaExpanded={open}
      ariaControls="ambio-investigations-menu"
      ariaHasPopup="dialog"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
      </svg>
    </ChromeButton>
  )
}
