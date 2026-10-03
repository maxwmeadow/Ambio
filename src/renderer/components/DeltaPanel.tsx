import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import {
  buildDeltaReview,
  claimRationale,
  clampClaimCursor,
  deltaAttribution,
  deltaHeadline,
  deltaWindow,
  realizationPresentation,
  sessionDuration,
  type DeltaReview,
} from '../canvas/deltaReview.ts'
import type { DeltaClaim } from '../../shared/types'
import { raiseFailure, raiseInvitation, raiseNotice, resolveInterruption } from '../store/interruptionStore.ts'
import { apiUndoArchitecture } from '../canvas/arcdApi.ts'
import { codeFitNoticeBody, openMakeCodeMatch } from '../canvas/codeFit.ts'
import { reviewMarkdown } from '../canvas/reviewMarkdown.ts'
import { NO_FILTER, claimMatches, isFiltered, reviewFilterOptions, type FilterOption, type ReviewFilter } from '../canvas/reviewFilters.ts'

/** One id, so a refreshed delta replaces its invitation instead of stacking. */
const DELTA_INVITATION = 'delta-review'

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

const KIND_TONE: Record<string, string> = {
  'system.coupling': 'coupling',
  'system.decoupling': 'decoupling',
  'system.hub': 'coupling',
  'system.orphaned': 'decoupling',
  'system.added': 'structural',
  'system.removed': 'structural',
  'system.membership': 'membership',
  'file.unclassified': 'pending',
  'system.internal': 'internal',
  'meaning.moved': 'membership',
  'meaning.renamed': 'membership',
  'meaning.nested': 'membership',
  'meaning.merged': 'structural',
  'meaning.ungrouped': 'structural',
  'meaning.grouped': 'structural',
  'infra.linked': 'coupling',
  'infra.unlinked': 'decoupling',
}

function actorBadge(actor: string): string {
  if (actor === 'agent') return 'AGENT'
  if (actor === 'both') return 'BOTH'
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
  const realization = claim.realizationState
    ? realizationPresentation(claim.realizationState)
    : null
  // Topology says what moved; only the agent that moved it can say why. When
  // nobody narrated the change, say so rather than leaving a silent gap.
  const why = claimRationale(claim, review)
  return (
    <li
      className="ambio-delta__claim"
      data-tone={KIND_TONE[claim.kind] ?? 'structural'}
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
        {why && <span className="ambio-delta__claim-why">“{why}”</span>}
        <span className="ambio-delta__claim-meta">
          <span className="ambio-delta__claim-sub">{claim.subtitle}</span>
          {claim.realizationState && realization && (
            <span
              className="ambio-delta__intent"
              data-status={claim.realizationState.toLowerCase()}
              title={realization.title}
            >
              {realization.label}
            </span>
          )}
          {!why && claim.actor === 'agent' && (
            <span className="ambio-delta__unexplained" title="No agent narrated this change">
              UNEXPLAINED
            </span>
          )}
          <span className="ambio-delta__actor" data-actor={claim.actor}>{actorBadge(claim.actor)}</span>
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
        {seen ? '✓ Seen' : 'Seen'}
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
          {expanded ? '▾' : '▸'} {evidence.length} evidence
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
    </li>
  )
}

type UndoState = { status: 'working' | 'done' } | { status: 'error'; message: string }

/** A filter worth offering only when there is more than one thing to choose. */
function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
}) {
  if (options.length < 2 && !value) return null
  return (
    <select className="ambio-delta__filter" aria-label={`${label} filter`} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{label}: all</option>
      {options.map(option => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
    </select>
  )
}

export function DeltaPanel() {
  const { delta, reviewing, cursor, deferredUntil, files, systems, startReview, setCursor, deferDelta, endReview } =
    useGraphStore(useShallow(state => ({
      delta: state.delta,
      reviewing: state.deltaReviewing,
      cursor: state.deltaCursor,
      deferredUntil: state.deltaDeferredUntil,
      files: state.files,
      systems: state.systems,
      startReview: state.startDeltaReview,
      setCursor: state.setDeltaCursor,
      deferDelta: state.deferDelta,
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
  const all = useMemo(
    () => (showInternal ? [...review.claims, ...review.internalClaims] : review.claims),
    [review, showInternal],
  )
  // Filters and "seen" belong to this review; a new delta starts clean.
  const [filter, setFilter] = useState<ReviewFilter>(NO_FILTER)
  const [seen, setSeen] = useState<Set<string>>(new Set())
  useEffect(() => { setFilter(NO_FILTER); setSeen(new Set()) }, [delta?.until])
  const filterContext = useMemo(() => ({
    sessions: review.sessions,
    systemOfFile: new Map(files.map(file => [file.id, file.systemId])),
    sessionGoals: new Map(review.sessionList.map(session => [session.id, session.goal])),
    systemNames: new Map(systems.map(system => [system.id, system.name])),
  }), [review, files, systems])
  const options = useMemo(() => reviewFilterOptions(all, filterContext), [all, filterContext])
  const unexplained = options.who.find(option => option.value === 'unexplained')?.count ?? 0
  const visible = useMemo(
    () => all.filter(claim => claimMatches(claim, filter, filterContext, seen)),
    [all, filter, filterContext, seen],
  )
  const toggleSeen = useCallback((id: string) => {
    setSeen(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const active = clampClaimCursor(visible, cursor)

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
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor(Math.min(active + 1, visible.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor(Math.max(active - 1, 0))
      } else if (event.key === 'Enter' && visible[active]) {
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
  }, [reviewing, active, visible, setCursor, endReview, toggleEvidence, toggleSeen])

  // Keep the active claim in view when moving by keyboard.
  useEffect(() => {
    if (!reviewing || active < 0) return
    const node = listRef.current?.children[active] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [reviewing, active])

  // The invitation to review lives in the interruption lane, not beside it.
  // It used to be a strip at top-centre - the same coordinates the lane now
  // occupies, so the two covered each other exactly like the banners this was
  // supposed to have fixed. One surface owns that space; this is a tenant.
  const pending = Boolean(delta) && !review.empty && !reviewing &&
    deferredUntil !== delta?.until
  useEffect(() => {
    if (!pending || !delta) {
      resolveInterruption(DELTA_INVITATION)
      return
    }
    // No "Later" button: the × beside it already means exactly that, and two
    // controls for one gesture invited the reading that they differ. Dismissal
    // now records the deferral, which is what keeps the delta unreviewed in
    // archd and puts the way back into the status bar.
    raiseInvitation(
      DELTA_INVITATION,
      deltaHeadline(review),
      `${deltaWindow(delta.since, delta.until)} · ${deltaAttribution(delta.counts)}`,
      [{ label: 'Review', primary: true, run: startReview }],
      deferDelta,
      'Set aside - stays unreviewed, reopen from the status bar',
    )
  }, [pending, delta, review, startReview, deferDelta])

  // Only the expanded review renders here now; the invitation is a lane tenant.
  if (!delta || review.empty || !reviewing) return null

  return (
    <aside className="ambio-delta ambio-delta--panel" aria-label="Reviewing changes">
      <header className="ambio-delta__header">
        <span className="ambio-delta__mode">Delta</span>
        <div className="ambio-delta__identity">
          <strong>{deltaHeadline(review)}</strong>
          <span>{deltaWindow(delta.since, delta.until)} · {deltaAttribution(delta.counts)}</span>
        </div>
        {unexplained > 0 && (
          <button
            type="button"
            className="ambio-delta__unexplained-count"
            aria-pressed={filter.who === 'unexplained'}
            title="Changes an agent made without saying what work they were for"
            onClick={() => setFilter(f => ({ ...NO_FILTER, who: f.who === 'unexplained' ? '' : 'unexplained' }))}
          >
            {unexplained} unexplained
          </button>
        )}
        <button
          type="button"
          className="ambio-delta__copy"
          title="Copy these changes as Markdown, for a pull request or a standup"
          onClick={() => {
            const text = reviewMarkdown({
              headline: deltaHeadline(review),
              window: deltaWindow(delta.since, delta.until),
              claims: review.claims,
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
          className="ambio-delta__close"
          aria-label="Close review, keep the delta"
          onClick={() => endReview(false)}
        >
          ×
        </button>
      </header>

      {review.sessionList.length > 0 && (
        <ol className="ambio-delta__sessions" aria-label="What the agents said they were doing">
          {review.sessionList.map(session => (
            <li key={session.id} className="ambio-delta__session">
              <span className="ambio-delta__session-goal">{session.goal}</span>
              <span className="ambio-delta__session-meta">
                <span className="ambio-delta__actor" data-actor="agent">
                  {(session.agent || 'agent').toUpperCase()}
                </span>
                {sessionDuration(session)}
                {session.endedAt === 0 && ' · still working'}
              </span>
              {session.summary && (
                <span className="ambio-delta__session-summary">{session.summary}</span>
              )}
              {session.notes.length > 0 && (
                <ul className="ambio-delta__session-notes">
                  {session.notes.map((note, index) => (
                    <li key={`${session.id}:${index}`}>- {note.text}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="ambio-delta__filters" role="group" aria-label="Filter changes">
        <FilterSelect label="Who" value={filter.who} options={options.who} onChange={who => setFilter(f => ({ ...f, who }))} />
        <FilterSelect label="Work" value={filter.work} options={options.work} onChange={work => setFilter(f => ({ ...f, work }))} />
        <FilterSelect label="Kind" value={filter.kind} options={options.kind} onChange={kind => setFilter(f => ({ ...f, kind }))} />
        <FilterSelect label="System" value={filter.system} options={options.system} onChange={system => setFilter(f => ({ ...f, system }))} />
        <label className="ambio-delta__filter-check">
          <input type="checkbox" checked={filter.hideSeen} onChange={event => setFilter(f => ({ ...f, hideSeen: event.target.checked }))} />
          Hide seen{seen.size > 0 ? ` (${seen.size})` : ''}
        </label>
        {isFiltered(filter) && (
          <span className="ambio-delta__filter-count">
            {visible.length} of {all.length}
            <button type="button" onClick={() => setFilter(NO_FILTER)}>Clear</button>
          </span>
        )}
      </div>

      <ol className="ambio-delta__claims" ref={listRef}>
        {visible.map((claim, index) => (
          <ClaimRow
            key={claim.id}
            claim={claim}
            review={review}
            active={index === active}
            expanded={expanded.has(claim.id)}
            onSelect={() => setCursor(index)}
            onToggle={() => toggleEvidence(claim.id)}
            undo={undos[claim.id]}
            onUndo={() => void undoClaim(claim)}
            seen={seen.has(claim.id)}
            onSeen={() => toggleSeen(claim.id)}
          />
        ))}
      </ol>

      <footer className="ambio-delta__footer">
        {review.internalClaims.length > 0 && (
          <button
            type="button"
            className="ambio-delta__reveal"
            aria-pressed={showInternal}
            onClick={() => setShowInternal(value => !value)}
          >
            {showInternal ? 'Hide' : 'Show'} {review.internalClaims.length} internal change
            {review.internalClaims.length > 1 ? 's' : ''}
          </button>
        )}
        <div className="ambio-delta__footer-actions">
          <kbd className="ambio-delta__hint">J / K · S</kbd>
          <button
            type="button"
            className="ambio-delta__button ambio-delta__button--primary"
            title="Mark this delta reviewed"
            onClick={() => endReview(true)}
          >
            Accept all
          </button>
        </div>
      </footer>
    </aside>
  )
}
