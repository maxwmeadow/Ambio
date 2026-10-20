import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CHECKOUTS_CHANGED, useCheckoutStore } from '../store/checkoutStore'
import { useCommandHandlers } from '../app/commands'
import { buildBranchChip, buildCheckoutRows, type OverlayLens } from './checkoutModel'
import { apiFocusCheckout, apiGetBranchReview } from '../canvas/arcdApi'
import { useGraphStore } from '../store/graphStore'
import type { BranchReview } from '../../shared/types'

const LENSES: Array<{ value: OverlayLens; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'Draw no other branch on the Floor' },
  { value: 'agents', label: 'Agents only', title: 'Draw branches an agent is working in' },
  { value: 'all', label: 'All', title: 'Draw every other branch' },
]

const REFRESH_MS = 5000
const MENU_WIDTH = 380
const VIEWPORT_GUTTER = 8

/** Keeps the checkout snapshot current while a project is open. */
function useCheckoutRefresh(workspaceId: string) {
  const refresh = useCheckoutStore(state => state.refresh)
  useEffect(() => {
    void refresh(workspaceId)
    if (!workspaceId) return
    const now = () => { void refresh(workspaceId) }
    const whenVisible = () => { if (!document.hidden) now() }
    // Deferred, not immediate: resolving during the canvas's first paint lands
    // a render inside React Flow's initial fitView window and moves the camera.
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(now, { timeout: 1000 })
      : window.setTimeout(now, 250)
    // Other checkouts are not watched file by file, so their changes and
    // collisions are polled while the window is visible.
    const interval = window.setInterval(whenVisible, REFRESH_MS)
    window.addEventListener('focus', now)
    window.addEventListener(CHECKOUTS_CHANGED, now)
    document.addEventListener('visibilitychange', whenVisible)
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
      window.clearInterval(interval)
      window.removeEventListener('focus', now)
      window.removeEventListener(CHECKOUTS_CHANGED, now)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [workspaceId, refresh])
}

/**
 * The branch the Floor shows, always in view, and the way to every other
 * checkout of the project. Replaces the floating Agent Lane, which opened
 * itself whenever a second worktree appeared.
 */
export function BranchChip({ workspaceId }: { workspaceId: string }) {
  useCheckoutRefresh(workspaceId)
  const snapshot = useCheckoutStore(state => (state.workspaceId === workspaceId ? state.snapshot : null))
  const chip = useMemo(() => buildBranchChip(snapshot), [snapshot])
  const rows = useMemo(() => buildCheckoutRows(snapshot), [snapshot])
  const lens = useCheckoutStore(state => state.lens)
  const setLens = useCheckoutStore(state => state.setLens)
  const unplaced = useCheckoutStore(state => state.unplaced)
  const [showing, setShowing] = useState<string | null>(null)
  // "Review this branch" swaps the popover's list for that branch's claims.
  const [reviewing, setReviewing] = useState<{ rootId: string; name: string } | null>(null)
  const [review, setReview] = useState<BranchReview | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const setSelectedNode = useGraphStore(state => state.setSelectedNode)
  const setInspectedNode = useGraphStore(state => state.setInspectedNode)

  useEffect(() => {
    setReview(null)
    setReviewError(null)
    if (!reviewing) return
    const request = new AbortController()
    apiGetBranchReview(workspaceId, reviewing.rootId, undefined, request.signal)
      .then(setReview)
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          setReviewError(error instanceof Error ? error.message : 'Ambio could not review that branch.')
        }
      })
    return () => request.abort()
  }, [reviewing, workspaceId])
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const anchorRef = useRef<HTMLButtonElement>(null)

  const updatePosition = useCallback(() => {
    const bounds = anchorRef.current?.getBoundingClientRect()
    if (!bounds) return
    const left = Math.max(VIEWPORT_GUTTER, Math.min(bounds.left, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER))
    setPosition({ left, top: bounds.bottom + 5 })
  }, [])

  const toggle = useCallback(() => {
    setNotice(null)
    setOpen(current => {
      if (!current) {
        updatePosition()
        void useCheckoutStore.getState().refresh(workspaceId)
      }
      return !current
    })
  }, [updatePosition, workspaceId])

  useCommandHandlers({ 'view.checkouts': toggle })

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  useEffect(() => { setOpen(false) }, [workspaceId])
  useEffect(() => { if (!open) setReviewing(null) }, [open])

  const showOnFloor = async (rootId: string) => {
    setShowing(rootId)
    setNotice(null)
    try {
      await apiFocusCheckout(workspaceId, rootId)
      await useCheckoutStore.getState().refresh(workspaceId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ambio could not show that checkout.')
    } finally {
      setShowing(null)
    }
  }

  const openCheckout = async (rootId: string, how: 'reveal' | 'editor') => {
    const result = await window.ambio?.openCheckout?.(workspaceId, rootId, how)
    setNotice(result && !result.ok ? result.detail : null)
  }

  if (!chip.visible) return null
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className="ambio-branch-chip"
        data-plain={chip.plain || undefined}
        data-colliding={chip.collisions > 0 || undefined}
        title={chip.title}
        aria-label={`Branches and worktrees: ${chip.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="ambio-checkouts"
        onClick={toggle}
      >
        <span className="ambio-branch-chip__kicker">{chip.plain ? 'Version control' : 'Branch'}</span>
        <span className="ambio-branch-chip__line">
          {!chip.plain && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" />
              <path d="M6 7.2v9.6M18 10.2c0 4-6 3.4-11 7" />
            </svg>
          )}
          <strong>{chip.label}</strong>
          {chip.dirty && <span className="ambio-branch-chip__dirty" aria-label="uncommitted changes" />}
          {chip.ahead > 0 && <span className="ambio-branch-chip__count">↑{chip.ahead}</span>}
          {chip.behind > 0 && <span className="ambio-branch-chip__count">↓{chip.behind}</span>}
          {chip.others > 0 && <span className="ambio-branch-chip__count">+{chip.others} worktree{chip.others === 1 ? '' : 's'}</span>}
          {chip.collisions > 0 && <span className="ambio-branch-chip__collisions">{chip.collisions} shared</span>}
        </span>
      </button>

      {open && createPortal(
        <>
          <div className="ambio-checkouts-scrim" onPointerDown={() => setOpen(false)} />
          <section
            className="ambio-checkouts"
            id="ambio-checkouts"
            role="dialog"
            aria-label="Branches and worktrees"
            style={{ '--ambio-checkouts-left': `${position.left}px`, '--ambio-checkouts-top': `${position.top}px` } as React.CSSProperties}
          >
            <header className="ambio-checkouts__header">
              <div>
                <h2>{chip.plain ? 'No Git' : reviewing ? `Review ${reviewing.name}` : 'Branches and worktrees'}</h2>
                <p>{chip.plain ? 'This folder is not a Git repository'
                  : reviewing ? (review ? `Against ${review.base || 'its base'} · ${review.files} file${review.files === 1 ? '' : 's'}` : 'Reading the branch…')
                  : 'Every working copy of this project'}</p>
              </div>
              {!chip.plain && !reviewing && <output>{rows.length}</output>}
              {reviewing && <button type="button" className="ambio-checkouts__back" onClick={() => setReviewing(null)}>← Back</button>}
            </header>
            {reviewing ? (
              <div className="ambio-checkouts__body ambio-checkouts__review">
                {reviewError && <p className="ambio-checkouts__notice" role="alert">{reviewError}</p>}
                {review?.message && <p className="ambio-checkouts__unplaced">{review.message}</p>}
                {review && review.claims.length > 0 && (
                  <ul className="ambio-delta__claims">
                    {review.claims.filter(claim => !claim.internal).map(claim => (
                      <li key={claim.id} className="ambio-delta__claim" data-cycle={claim.createsCycle || undefined}>
                        <button
                          type="button"
                          className="ambio-delta__claim-head"
                          onClick={() => {
                            const systemId = claim.focusSystemIds?.[0]
                            if (systemId) { setSelectedNode(systemId); setInspectedNode(systemId) }
                          }}
                        >
                          <span className="ambio-delta__claim-title">
                            {claim.createsCycle && <span className="ambio-delta__cycle">CYCLE</span>}
                            {claim.title}
                          </span>
                          <span className="ambio-delta__claim-meta">
                            <span className="ambio-delta__claim-sub">{claim.subtitle}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {review?.truncated ? <p className="ambio-checkouts__unplaced">{review.truncated} more changed files were not read.</p> : null}
              </div>
            ) : (<>
            {rows.length > 1 && (
              <div className="ambio-checkouts__lens">
                <span>Other branches on the Floor</span>
                <div role="radiogroup" aria-label="Other branches on the Floor">
                  {LENSES.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={lens === option.value}
                      title={option.title}
                      onClick={() => setLens(option.value)}
                    >{option.label}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="ambio-checkouts__body">
              {rows.map(row => (
                <article className="ambio-checkout" key={row.rootId} data-focused={row.focused || undefined}>
                  <div className="ambio-checkout__title">
                    <strong title={row.name}>{row.name}</strong>
                    {row.focused && <span className="ambio-checkout__tag">on the Floor</span>}
                    {row.primary && !chip.plain && <span className="ambio-checkout__tag ambio-checkout__tag--quiet">primary</span>}
                  </div>
                  {row.state && <p className="ambio-checkout__state">{row.state}</p>}
                  {/* Left-to-right marks keep the path's own order while the
                      ellipsis, set right-to-left, trims its start. */}
                  <code className="ambio-checkout__path" title={row.path}>{'\u200E'}{row.path}{'\u200E'}</code>
                  {row.agents.length > 0 && (
                    <ul className="ambio-checkout__agents">
                      {row.agents.map(agent => (
                        <li key={agent.id} title={agent.goal}><span>{agent.name}</span> {agent.goal}</li>
                      ))}
                    </ul>
                  )}
                  {row.overlay && (
                    <p className="ambio-checkout__overlay" style={{ color: row.tint }}>
                      <span className="ambio-checkout__swatch" aria-hidden="true" />
                      {row.overlay} on its branch
                    </p>
                  )}
                  {(row.touchedSystems > 0 || row.collidingSystems > 0) && (
                    <p className="ambio-checkout__systems">
                      {row.touchedSystems > 0 && <span>{row.touchedSystems} system{row.touchedSystems === 1 ? '' : 's'} changing</span>}
                      {row.collidingSystems > 0 && <span data-colliding>{row.collidingSystems} shared with another branch</span>}
                    </p>
                  )}
                  <div className="ambio-checkout__actions">
                    {row.canShow && (
                      <button type="button" disabled={showing !== null} onClick={() => void showOnFloor(row.rootId)}>
                        {showing === row.rootId ? 'Showing…' : 'Show on the Floor'}
                      </button>
                    )}
                    {row.canReview && (
                      <button type="button" onClick={() => setReviewing({ rootId: row.rootId, name: row.name })}>Review this branch</button>
                    )}
                    <button type="button" onClick={() => void openCheckout(row.rootId, 'reveal')}>Reveal folder</button>
                    <button type="button" onClick={() => void openCheckout(row.rootId, 'editor')}>Open in editor</button>
                  </div>
                </article>
              ))}
              {unplaced > 0 && (
                <p className="ambio-checkouts__unplaced">
                  {unplaced} new file{unplaced === 1 ? '' : 's'} on other branches {unplaced === 1 ? 'is' : 'are'} in folders no system owns yet.
                </p>
              )}
              {notice && <p className="ambio-checkouts__notice" role="status">{notice}</p>}
            </div>
            </>)}
          </section>
        </>,
        document.body,
      )}
    </>
  )
}

