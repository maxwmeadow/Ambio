import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CHECKOUTS_CHANGED, REVIEW_BRANCH, useCheckoutStore } from '../store/checkoutStore'
import { useCommandHandlers } from '../app/commands'
import { buildBranchChip, buildCheckoutRows, buildRepositoryRows, type OverlayLens } from './checkoutModel'
import { apiFinishRunWorktree, apiFocusCheckout, apiGetBranchReview, apiListBranches, apiSwitchBranch } from '../canvas/arcdApi'
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
  const repositories = useMemo(() => buildRepositoryRows(snapshot), [snapshot])
  // A folder of repositories has no checkout of its own worth a row.
  const rows = useMemo(() => (chip.repositories ? [] : buildCheckoutRows(snapshot)), [snapshot, chip.repositories])
  const lens = useCheckoutStore(state => state.lens)
  const setLens = useCheckoutStore(state => state.setLens)
  const unplaced = useCheckoutStore(state => state.unplaced)
  const [showing, setShowing] = useState<string | null>(null)
  // "Switch branch…" swaps the list for the repository's local branches.
  const [branches, setBranches] = useState<{ current: string; branches: Array<{ name: string; rootId?: string }> } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
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
  // A notice is an error unless an action reports what it did.
  const [noticeDone, setNoticeDone] = useState(false)
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
  useEffect(() => {
    const reviewBranch = (event: Event) => {
      const detail = (event as CustomEvent<{ rootId: string; name: string }>).detail
      if (!detail?.rootId) return
      updatePosition()
      setOpen(true)
      setReviewing(detail)
    }
    window.addEventListener(REVIEW_BRANCH, reviewBranch)
    return () => window.removeEventListener(REVIEW_BRANCH, reviewBranch)
  }, [updatePosition])
  useEffect(() => { if (!open) { setReviewing(null); setBranches(null); setConfirmDiscard(null) } }, [open])

  const showOnFloor = async (rootId: string) => {
    setShowing(rootId)
    setNotice(null)
    setNoticeDone(false)
    try {
      await apiFocusCheckout(workspaceId, rootId)
      await useCheckoutStore.getState().refresh(workspaceId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ambio could not show that checkout.')
    } finally {
      setShowing(null)
    }
  }

  const act = async (key: string, work: () => Promise<string | null>) => {
    setBusy(key)
    setNotice(null)
    try {
      const done = await work()
      setNotice(done)
      setNoticeDone(true)
      await useCheckoutStore.getState().refresh(workspaceId)
    } catch (error) {
      setNoticeDone(false)
      setNotice(error instanceof Error ? error.message : 'Ambio could not do that.')
    } finally {
      setBusy(null)
    }
  }

  const finishRun = (rootId: string, action: 'apply' | 'discard') => act(`${action}:${rootId}`, async () => {
    setConfirmDiscard(null)
    const result = await apiFinishRunWorktree(workspaceId, rootId, action)
    if (action === 'discard') return 'The run and its worktree are gone.'
    return result.conflicted
      ? `The run's work is in ${result.into} with conflicts to resolve; its worktree stays until you do.`
      : `The run's work is in ${result.into} as uncommitted changes. Review and commit it there.`
  })

  const openBranches = () => act('branches', async () => {
    setBranches(await apiListBranches(workspaceId))
    return null
  })

  const switchTo = (branch: { name: string; rootId?: string }) => act(`switch:${branch.name}`, async () => {
    if (branch.rootId) {
      // Git keeps a branch in one worktree at a time: show that one instead.
      await apiFocusCheckout(workspaceId, branch.rootId)
    } else {
      await apiSwitchBranch(workspaceId, branch.name)
    }
    setBranches(null)
    return null
  })

  const openCheckout = async (rootId: string, how: 'reveal' | 'editor') => {
    const result = await window.ambio?.openCheckout?.(workspaceId, rootId, how)
    setNoticeDone(false)
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
        <span className="ambio-branch-chip__kicker">{chip.plain ? 'Version control' : chip.repositories ? 'Repositories' : 'Branch'}</span>
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
                <h2>{chip.repositories ? 'Repositories' : chip.plain ? 'No Git' : reviewing ? `Review ${reviewing.name}` : branches ? 'Switch branch' : 'Branches and worktrees'}</h2>
                <p>{chip.repositories ? 'Each repository in this folder' : chip.plain ? 'This folder is not a Git repository'
                  : reviewing ? (review ? `Against ${review.base || 'its base'} · ${review.files} file${review.files === 1 ? '' : 's'}` : 'Reading the branch…')
                  : branches ? `The Floor is on ${branches.current}`
                  : 'Every working copy of this project'}</p>
              </div>
              {!chip.plain && !reviewing && !branches && <output>{chip.repositories || rows.length}</output>}
              {(reviewing || branches) && <button type="button" className="ambio-checkouts__back" onClick={() => { setReviewing(null); setBranches(null) }}>← Back</button>}
            </header>
            {branches && !reviewing ? (
              <div className="ambio-checkouts__body">
                <ul className="ambio-checkouts__branches">
                  {branches.branches.map(branch => (
                    <li key={branch.name}>
                      <button
                        type="button"
                        disabled={busy !== null || branch.name === branches.current}
                        aria-current={branch.name === branches.current || undefined}
                        onClick={() => void switchTo(branch)}
                      >
                        <strong>{branch.name}</strong>
                        {branch.name === branches.current ? <span>on the Floor</span> : branch.rootId ? <span>open in a worktree · show it</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
                {notice && <p className="ambio-checkouts__notice" data-done={noticeDone || undefined} role="status">{notice}</p>}
              </div>
            ) : reviewing ? (
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
                    {row.ambioRun && <span className="ambio-checkout__tag ambio-checkout__tag--quiet">Ambio run</span>}
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
                    {row.canSwitch && (
                      <button type="button" disabled={busy !== null} onClick={() => void openBranches()}>Switch branch…</button>
                    )}
                    {row.ambioRun && (
                      <button type="button" disabled={busy !== null} title={`Bring this run's work into ${chip.label} as uncommitted changes`} onClick={() => void finishRun(row.rootId, 'apply')}>
                        {busy === `apply:${row.rootId}` ? 'Applying…' : `Apply to ${chip.label}`}
                      </button>
                    )}
                    {row.ambioRun && (confirmDiscard === row.rootId
                      ? <button type="button" data-danger disabled={busy !== null} onClick={() => void finishRun(row.rootId, 'discard')}>Discard its work</button>
                      : <button type="button" disabled={busy !== null} onClick={() => setConfirmDiscard(row.rootId)}>Discard…</button>)}
                    <button type="button" onClick={() => void openCheckout(row.rootId, 'reveal')}>Reveal folder</button>
                    <button type="button" onClick={() => void openCheckout(row.rootId, 'editor')}>Open in editor</button>
                  </div>
                </article>
              ))}
              {repositories.length > 0 && (
                <section className="ambio-checkouts__repositories" aria-label="Repositories in this folder">
                  {!chip.repositories && <h3>Inside this repository</h3>}
                  {repositories.map(repository => (
                    <article className="ambio-checkout" key={repository.folder}>
                      <div className="ambio-checkout__title">
                        <strong title={repository.folder}>{repository.folder}</strong>
                        <span className="ambio-checkout__tag ambio-checkout__tag--quiet">{repository.name}</span>
                      </div>
                      {repository.state && <p className="ambio-checkout__state">{repository.state}</p>}
                    </article>
                  ))}
                </section>
              )}
              {unplaced > 0 && (
                <p className="ambio-checkouts__unplaced">
                  {unplaced} new file{unplaced === 1 ? '' : 's'} on other branches {unplaced === 1 ? 'is' : 'are'} in folders no system owns yet.
                </p>
              )}
              {notice && <p className="ambio-checkouts__notice" data-done={noticeDone || undefined} role="status">{notice}</p>}
            </div>
            </>)}
          </section>
        </>,
        document.body,
      )}
    </>
  )
}

