import React from 'react'
import type { OverlayArrival, OverlayMark } from '../../components/checkoutModel'

/**
 * Another checkout's work on a Floor file: it changes or deletes this file
 * on its branch (docs/GIT_AND_PROJECT_SHAPES.md "The experience"). Sits on
 * the card's lower-left corner; the agent presence badge owns the upper
 * right. Dashed, because it is a branch's proposal for the file, not the file.
 */
export function BranchOverlayMark({ marks }: { marks?: OverlayMark[] }) {
  if (!marks?.length) return null
  const first = marks[0]
  const deleted = marks.every(mark => mark.change === 'deleted')
  const glyph = deleted ? '−' : '~'
  const label = marks.length === 1 ? first.name : `${marks.length} branches`
  const title = marks
    .map(mark => `${mark.change === 'deleted' ? 'Deleted' : 'Changed'} on ${mark.name}`)
    .join('\n')
  return (
    <div
      className="ambio-branch-overlay-mark nodrag nopan"
      data-change={deleted ? 'deleted' : 'modified'}
      title={title}
      aria-label={title}
      style={{ borderColor: first.tint, color: first.tint }}
    >
      <span aria-hidden="true" style={{ fontWeight: 700 }}>{glyph}</span>
      <span className="ambio-branch-overlay-mark__name">{label}</span>
    </div>
  )
}

/**
 * New files other checkouts add to a system: a dashed caption just below the
 * system's frame, one entry per branch, clear of its contents. Both marks are
 * counter-scaled against the zoom (canvasZoomChrome) like activity chrome.
 */
export function BranchArrivalsRail({ arrivals }: { arrivals?: OverlayArrival[] }) {
  if (!arrivals?.length) return null
  return (
    <div className="ambio-branch-arrivals nodrag nopan">
      {arrivals.map(arrival => {
        const names = arrival.paths.map(path => path.slice(path.lastIndexOf('/') + 1))
        const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '')
        return (
          <span
            key={arrival.rootId}
            className="ambio-branch-arrivals__entry"
            title={`New on ${arrival.name}:\n${arrival.paths.join('\n')}`}
            style={{ borderColor: arrival.tint, color: arrival.tint }}
          >
            <strong>+</strong> {shown} <em>{arrival.name}</em>
          </span>
        )
      })}
    </div>
  )
}
