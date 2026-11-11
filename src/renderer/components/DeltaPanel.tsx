import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import {
  buildDeltaReview,
  deltaHeadline,
  deltaWindow,
  realizationPresentation,
  type DeltaReview,
} from '../canvas/deltaReview.ts'
import type { DbFile, DbSystem, DeltaClaim, DeltaWorkSession } from '../../shared/types'
import { raiseFailure, raiseNotice, resolveInterruption } from '../store/interruptionStore.ts'
import { apiUndoArchitecture } from '../canvas/arcdApi.ts'
import { codeFitNoticeBody, openMakeCodeMatch } from '../canvas/codeFit.ts'
import { Chevron, DisclosureSummary } from './ui/Chevron'
import { InboxIcon } from './InboxIcon'
import { reviewMarkdown } from '../canvas/reviewMarkdown.ts'
import { NO_FILTER, claimMatches, isFiltered, reviewFilterOptions, type FilterOption, type ReviewFilter } from '../canvas/reviewFilters.ts'

/** Clear invitations left by earlier versions; review now stays in the toolbar. */
const DELTA_INVITATION = 'delta-review'
const EMPTY_FILES: DbFile[] = []
const EMPTY_SYSTEMS: DbSystem[] = []

/**
 * Morning Delta review panel.
 *
 * This replaced a horizontal scrubber, and the difference is not decoration.
 * A scrubber says "here is item 4 of 10" - you cannot see the shape of the
 * work, cannot skip what you don't care about, and cannot read a path in the
 * space available. Review is triage, not playback: you want the whole list at
 * once, ranked, with room for the actual names of things.
 *
 * Every row states an architectural claim in plain language. Its evidence
 * (call sites, files) is folded away until asked for, so a delta with 200
 * underlying changes still reads as a handful of statements.
 */

function actorBadge(actor: string): string {
  if (actor === 'agent') return 'AGENT'
  if (actor === 'both') return 'BOTH'
  if (actor === 'git') return 'GIT'
  return 'YOU'
}

function ClaimRow({
  claim, review, active, expanded, onSelect, onToggle, undo, onUndo, seen, onSeen,
}: {
  claim: DeltaClaim
  review: DeltaReview
  active: boolean
  expanded: boolean
  onSelect: () => void
  onToggle: () => void
  undo?: UndoState
  onUndo: () => void
  seen: boolean
  onSeen: () => void
}) {
  const evidence = [...(claim.realizationEvidence ?? []), ...claim.evidence]
  const hasEvidence = evidence.length > 0
  const realization = claim.realizationState && claim.realizationState !== 'UNKNOWN'
    ? realizationPresentation(claim.realizationState)
    : null
  // Topology says what moved; only the agent that moved it can say why. When
  // nobody narrated the change, say so rather than leaving a silent gap.
  const session = claim.sessionId ? review.sessions.get(claim.sessionId) : undefined
  return (
    <li
      className="ambio-delta__claim"
      data-active={active || undefined}
      data-cycle={claim.createsCycle || undefined}
      data-seen={seen || undefined}
      aria-current={active ? 'true' : undefined}
    >
      <button type="button" className="ambio-delta__claim-head" onClick={onSelect}>
        <span className="ambio-delta__claim-title">
          {claim.createsCycle && <span className="ambio-delta__cycle">CYCLE</span>}
          {claim.title}
        </span>
        <span className="ambio-delta__claim-meta">
          {!claim.internal && claim.subtitle && <span>{claim.subtitle}</span>}
          {claim.realizationState && realization && (
            <span
              className="ambio-delta__intent"
              data-status={claim.realizationState.toLowerCase()}
              title={realization.title}
            >
              {realization.label}
            </span>
          )}
          {!session && claim.actor === 'agent' && (
            <span className="ambio-delta__unexplained" title="No agent narrated this change">
              UNEXPLAINED
            </span>
          )}
          <span className="ambio-delta__actor" data-actor={claim.actor}>{(claim.actor === 'agent' && session?.agent) || actorBadge(claim.actor)}</span>
        </span>
      </button>
      <button
        type="button"
        className="ambio-delta__seen"
        aria-pressed={seen}
        aria-label={seen ? `Mark “${claim.title}” unseen` : `Mark “${claim.title}” seen`}
        title={seen ? 'Seen - press S to unmark' : 'Mark seen (S)'}
        onClick={onSeen}
      >
        {seen ? <><InboxIcon name="check" size={12} /> Seen</> : 'Mark seen'}
      </button>

      {claim.undoEventIds && claim.undoEventIds.length > 0 && (
        <div className="ambio-delta__undo-row">
          {undo?.status === 'done'
            ? <span className="ambio-delta__undone">Undone</span>
            : (
              <button
                type="button"
                className="ambio-delta__undo"
                disabled={undo?.status === 'working'}
                onClick={onUndo}
                title="Put the map back the way it was before this change"
              >
                {undo?.status === 'working' ? 'Undoing…' : 'Undo'}
              </button>
            )}
          {undo?.status === 'error' && <span className="ambio-delta__undo-error" role="alert">{undo.message}</span>}
        </div>
      )}

      {claim.codeFit && claim.codeFit.length > 0 && undo?.status !== 'done' && (
        <div className="ambio-delta__code-fit">
          <span>{codeFitNoticeBody(claim.codeFit)}</span>
          <button
            type="button"
            className="ambio-delta__undo"
            onClick={() => openMakeCodeMatch(claim.codeFit!)}
            title="Send an agent the work that makes the code agree with the map"
          >
            Make the Code Match…
          </button>
        </div>
      )}

      {hasEvidence && (
        <button
          type="button"
          className="ambio-delta__evidence-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Chevron expanded={expanded} /> Evidence ({evidence.length})
        </button>
      )}

      {expanded && hasEvidence && (
        <ul className="ambio-delta__evidence">
          {evidence.map((item, index) => (
            <li key={`${claim.id}:${index}`}>
              <span className="ambio-delta__evidence-label">{item.label}</span>
              {item.detail && <span className="ambio-delta__evidence-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {session && (
        <details className="ambio-delta__report">
          <DisclosureSummary>{session.agent || 'Agent'} report</DisclosureSummary>
          <SessionReport session={session} />
        </details>
      )}
    </li>
  )
}

type UndoState = { status: 'working' | 'done' } | { status: 'error'; message: string }

function SessionReport({ session }: { session: DeltaWorkSession }) {
  return (
    <div className="ambio-delta__session">
      <strong>{session.goal}</strong>
      {!session.endedAt && <span className="ambio-delta__session-meta">Still working</span>}
      {session.summary && <p>{session.summary}</p>}
      {session.notes.length > 0 && (
        <ul>{session.notes.map((note, index) => <li key={index}>{note.text}</li>)}</ul>
      )}
    </div>
  )
}

const FILTER_LABELS = {
  who: { label: 'Who', reset: 'Everyone' },
  work: { label: 'Work', reset: 'All work' },
  kind: { label: 'Kind', reset: 'All kinds' },
  system: { label: 'System', reset: 'All systems' },
}

type FilterKey = keyof typeof FILTER_LABELS

function ReviewFilters({ options, filter, setFilter, visible, total, seenCount, unexplained, canRevealInternal, showInternal, internalCount, onToggleInternal }: {
  options: Record<FilterKey, FilterOption[]>
  filter: ReviewFilter
  setFilter: (filter: ReviewFilter) => void
  visible: number
  total: number
  seenCount: number
  unexplained: number
  canRevealInternal: boolean
  showInternal: boolean
  internalCount: number
  onToggleInternal: () => void
}) {
  const [open, setOpen] = useState<FilterKey | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const returnFocus = () => wrapper.current?.querySelector<HTMLButtonElement>(`[data-filter="${open}"]`)?.focus()
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const keys = (Object.keys(FILTER_LABELS) as FilterKey[]).filter(key => options[key].length >= 2 || filter[key])
  const hasFilters = isFiltered({ ...filter, hideSeen: false })
  const canHideSeen = seenCount > 0 || filter.hideSeen
  if (!keys.length && !canHideSeen && !canRevealInternal && !unexplained) return null

  return (
    <div ref={wrapper} className="ambio-delta__filter-area" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(null)
    }} onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      returnFocus()
      setOpen(null)
    }}>
      <div className="ambio-delta__filters" role="group" aria-label="Filter changes">
        {keys.map(key => {
          const label = FILTER_LABELS[key].label
          const selected = options[key].find(option => option.value === filter[key])?.label
          return (
            <button key={key} type="button" className="ambio-delta__filter-chip" data-filter={key}
              data-selected={Boolean(filter[key]) || undefined} aria-label={`${label} filter`}
              aria-haspopup="menu" aria-expanded={open === key} aria-controls={open === key ? id : undefined}
              title={selected ? `${label} filter: ${selected}` : undefined}
              onClick={() => setOpen(open === key ? null : key)}>
              <span>{selected ?? label}</span><Chevron expanded={open === key} />
            </button>
          )
        })}
        {canHideSeen && (
          <button type="button" className="ambio-delta__filter-chip" aria-pressed={filter.hideSeen}
            onClick={() => setFilter({ ...filter, hideSeen: !filter.hideSeen })}>
            {filter.hideSeen && <InboxIcon name="check" size={12} />} Hide seen
          </button>
        )}
        {canRevealInternal && (
          <button type="button" className="ambio-delta__filter-chip" aria-pressed={showInternal} onClick={onToggleInternal}>
            Internal edits ({internalCount})
          </button>
        )}
        {unexplained > 0 && (
          <button type="button" className="ambio-delta__filter-chip" aria-pressed={filter.who === 'unexplained'}
            onClick={() => setFilter({ ...NO_FILTER, who: filter.who === 'unexplained' ? '' : 'unexplained' })}>
            {unexplained} unexplained
          </button>
        )}
        {(visible < total || hasFilters) && (
          <span className="ambio-delta__filter-count">
            {visible < total && <span>{visible} of {total}</span>}
            {hasFilters && <button type="button" onClick={() => setFilter(NO_FILTER)}>Clear filters</button>}
          </span>
        )}
      </div>
      {open && (
        <div ref={menu} id={id} className="ambio-delta__filter-menu" role="menu" aria-label={`Filter by ${FILTER_LABELS[open].label.toLowerCase()}`}
          onKeyDown={event => {
            const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
            if (!keys.includes(event.key)) return
            const items = [...event.currentTarget.querySelectorAll('button')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
            event.preventDefault()
            items[next]?.focus()
          }}>
          {[{ value: '', label: FILTER_LABELS[open].reset, count: total }, ...options[open]].map(option => (
            <button key={option.value} type="button" role="menuitemradio" aria-checked={filter[open] === option.value}
              onClick={() => {
                returnFocus()
                setOpen(null)
                setFilter({ ...filter, [open]: option.value })
              }}>
              <span>{option.label}</span>
              <small>{option.count}</small>
              {filter[open] === option.value && <InboxIcon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function DeltaPanel() {
  const { delta, reviewing, claimId, files, systems, selectClaim, endReview } =
    useGraphStore(useShallow(state => ({
      delta: state.delta,
      reviewing: state.deltaReviewing,
      claimId: state.deltaClaimId,
      files: state.delta ? state.files : EMPTY_FILES,
      systems: state.delta ? state.systems : EMPTY_SYSTEMS,
      selectClaim: state.selectDeltaClaim,
      endReview: state.endDeltaReview,
    })))

  const [showInternal, setShowInternal] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // A review is a snapshot, so an undone claim is marked here; the next
  // delta after the review leaves out both the change and its undo.
  const [undos, setUndos] = useState<Record<string, UndoState>>({})
  const undoClaim = useCallback(async (claim: DeltaClaim) => {
    const workspaceId = useGraphStore.getState().currentProject?.id
    if (!workspaceId || !claim.undoEventIds?.length) return
    setUndos(current => ({ ...current, [claim.id]: { status: 'working' } }))
    try {
      await apiUndoArchitecture(workspaceId, claim.undoEventIds)
      setUndos(current => ({ ...current, [claim.id]: { status: 'done' } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setUndos(current => ({ ...current, [claim.id]: { status: 'error', message: `Can't undo: ${message}` } }))
    }
  }, [])
  const listRef = useRef<HTMLOListElement>(null)

  const knownNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const file of files) ids.add(file.id)
    for (const system of systems) ids.add(system.id)
    return ids
  }, [files, systems])

  const review = useMemo(() => buildDeltaReview(delta, knownNodeIds), [delta, knownNodeIds])
  const observed = useMemo(() => [...review.claims, ...review.internalClaims], [review])
  const otherSessions = useMemo(() => {
    const linked = new Set(observed.map(claim => claim.sessionId))
    return review.sessionList.filter(session => !linked.has(session.id))
  }, [observed, review.sessionList])
  const onlyInternal = review.claims.length === 0 && review.internalClaims.length > 0
  const all = showInternal || onlyInternal ? observed : review.claims
  // Filters and "seen" belong to this review; a new delta starts clean.
  const [filter, setFilter] = useState<ReviewFilter>(NO_FILTER)
  const [seen, setSeen] = useState<Set<string>>(new Set())
  useEffect(() => {
    setFilter(NO_FILTER)
    setSeen(new Set())
    setExpanded(new Set())
    setShowInternal(false)
    setUndos({})
  }, [delta?.until])
  const filterContext = useMemo(() => ({
    sessions: review.sessions,
    systemOfFile: new Map(reviewing ? files.map(file => [file.id, file.systemId]) : []),
    sessionGoals: new Map(review.sessionList.map(session => [session.id, session.goal])),
    systemNames: new Map(reviewing ? systems.map(system => [system.id, system.name]) : []),
  }), [reviewing, review, files, systems])
  const options = useMemo(() => reviewFilterOptions(all, filterContext), [all, filterContext])
  const unexplained = options.who.find(option => option.value === 'unexplained')?.count ?? 0
  const matching = useMemo(() => {
    const filtersWithoutSeen = { ...filter, hideSeen: false }
    return all.filter(claim => claimMatches(claim, filtersWithoutSeen, filterContext, seen))
  }, [all, filter, filterContext, seen])
  const seenCount = matching.filter(claim => seen.has(claim.id)).length
  const visible = useMemo(
    () => filter.hideSeen ? matching.filter(claim => !seen.has(claim.id)) : matching,
    [filter.hideSeen, matching, seen],
  )
  const toggleSeen = useCallback((id: string) => {
    setSeen(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const active = visible.findIndex(claim => claim.id === claimId)
  useLayoutEffect(() => {
    if (reviewing && active < 0) {
      const first = visible[0]?.id ?? null
      if (claimId !== first) selectClaim(first)
    }
  }, [active, claimId, reviewing, selectClaim, visible])

  const toggleEvidence = useCallback((id: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Keyboard triage, borrowed from PR review: j/k to move, Enter to expand,
  // Escape to leave. Reviewing fifty claims should never require the mouse.
  useEffect(() => {
    if (!reviewing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        selectClaim(visible[Math.min(active + 1, visible.length - 1)]?.id ?? null)
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        selectClaim(visible[Math.max(active - 1, 0)]?.id ?? null)
      } else if (event.key === 'Enter' && visible[active] && !target?.closest('button, summary, a')) {
        event.preventDefault()
        toggleEvidence(visible[active].id)
      } else if (event.key === 's' && visible[active]) {
        event.preventDefault()
        toggleSeen(visible[active].id)
      } else if (event.key === 'Escape') {
        endReview(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewing, active, visible, selectClaim, endReview, toggleEvidence, toggleSeen])

  // Keep the active claim in view when moving by keyboard.
  useEffect(() => {
    if (!reviewing || active < 0) return
    const node = listRef.current?.children[active] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [reviewing, active])

  // Changes accumulate quietly behind the toolbar's Review Changes control.
  // Each edit advances the delta window; turning those updates into invitations
  // made a dismissed notice return throughout an agent's coding session.
  useEffect(() => {
    resolveInterruption(DELTA_INVITATION)
  }, [])

  if (!delta || review.empty || !reviewing) return null

  return (
    <aside className="ambio-delta ambio-delta--panel" aria-label="Reviewing changes">
      <header className="ambio-delta__header">
        <h2>Review Changes</h2>
        <button type="button" className="ambio-delta__close" aria-label="Close review, keep the delta" onClick={() => endReview(false)}>×</button>
      </header>

      <ReviewFilters key={delta.until} options={options} filter={filter} setFilter={setFilter}
        visible={visible.length} total={all.length} seenCount={seenCount} unexplained={unexplained}
        canRevealInternal={!onlyInternal && review.internalClaims.length > 0}
        showInternal={showInternal} internalCount={review.internalClaims.length}
        onToggleInternal={() => setShowInternal(value => !value)} />

      <div className="ambio-delta__body">
        {visible.length === 0 && <p className="ambio-delta__empty">
          {filter.hideSeen && seenCount > 0 ? 'All matching changes are marked seen.' : 'No changes match these filters.'}
        </p>}
        <ol className="ambio-delta__claims" ref={listRef}>
          {visible.map(claim => (
            <ClaimRow
              key={claim.id}
              claim={claim}
              review={review}
              active={claim.id === claimId}
              expanded={expanded.has(claim.id)}
              onSelect={() => selectClaim(claim.id)}
              onToggle={() => toggleEvidence(claim.id)}
              undo={undos[claim.id]}
              onUndo={() => void undoClaim(claim)}
              seen={seen.has(claim.id)}
              onSeen={() => toggleSeen(claim.id)}
            />
          ))}
        </ol>
        {otherSessions.length > 0 && (
          <details className="ambio-delta__other-work">
            <DisclosureSummary>Other agent activity ({otherSessions.length})</DisclosureSummary>
            {otherSessions.map(session => <SessionReport key={session.id} session={session} />)}
          </details>
        )}
      </div>

      <footer className="ambio-delta__footer">
        <button
          type="button"
          className="ambio-delta__button"
          onClick={() => {
            const text = reviewMarkdown({
              headline: deltaHeadline(review),
              window: deltaWindow(delta.since, delta.until),
              claims: observed,
              sessions: review.sessionList,
              projectName: useGraphStore.getState().currentProject?.name,
            })
            const copy = window.ambio?.copyText ? window.ambio.copyText(text) : navigator.clipboard.writeText(text)
            void copy.then(
              () => raiseNotice('review-copied', 'Review copied as Markdown'),
              error => raiseFailure('review-copied', "Couldn't copy the review", String(error)),
            )
          }}
        >
          Copy as Markdown
        </button>
        <button
          type="button"
          className="ambio-delta__button ambio-delta__button--primary"
          title="Mark the full review window as reviewed, including hidden changes"
          onClick={() => endReview(true)}
        >
          Mark reviewed
        </button>
      </footer>
    </aside>
  )
}
