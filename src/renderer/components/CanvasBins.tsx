import { useEffect, useMemo, useRef, useState } from 'react'
import type { DbFile } from '../../shared/types'
import { sortForBin } from '../canvas/binModel'
import { BinCanvasWindow } from './BinCanvasWindow'
import { useGraphStore } from '../store/graphStore'

/** Matches the pulse keyframes in bins.css. */
const ARRIVAL_PULSE_MS = 1400

/**
 * Two bins pinned to the canvas, holding the files that are not architecture
 * you have placed.
 *
 * Pinned to the viewport rather than parked in world space on purpose: you
 * must be able to reach a bin from wherever you happen to be looking, and a
 * bin you have to hunt for is one you stop using. Nothing here occupies map
 * coordinates or owns a layout row.
 *
 * The two bins deliberately open into different things, because they hold
 * different kinds of thing. Documentation is finished - you read it, so it
 * opens a browser. Unclassified files are unfinished - you place them, so they
 * open a small canvas you can drag out of.
 */

export const BINNED_FILE_MIME = 'application/ambio-binned-file'

interface CanvasBinsProps {
  documents: readonly DbFile[]
  unclassified: readonly DbFile[]
  /** Toggles the documents reader; the button that opens it also closes it. */
  onToggleDocuments: () => void
  documentsOpen?: boolean
  /** True while a node is being dragged, so the unclassified bin can invite it. */
  dragActive?: boolean
  readOnly?: boolean
}

export function CanvasBins({
  documents,
  unclassified,
  onToggleDocuments,
  documentsOpen = false,
  dragActive = false,
  readOnly = false,
}: CanvasBinsProps) {
  const [openBin, setOpenBin] = useState<'unclassified' | null>(null)
  const sorted = useMemo(() => sortForBin(unclassified), [unclassified])

  // A file that lands unsorted no longer materialises on the Floor, so the
  // arrival is announced here instead - on the thing it actually landed in.
  // An agent building a feature can write dozens of files in a few seconds
  // before it assigns any of them. The first arrival pulses once; the rest of
  // the burst only keeps the bin lit, and it settles after a quiet spell.
  // Restarting the pulse per file made the tile strobe for the whole burst.
  const workspaceId = useGraphStore(state => state.currentProject?.id ?? '')
  const arrivalKey = useGraphStore(state => state.unsortedArrivalKey)
  const [pulseKey, setPulseKey] = useState(0)
  const seenArrival = useRef(arrivalKey)
  const quietTimer = useRef<number | null>(null)
  useEffect(() => {
    if (arrivalKey === seenArrival.current) return
    seenArrival.current = arrivalKey
    setPulseKey(current => current || arrivalKey)
    if (quietTimer.current !== null) window.clearTimeout(quietTimer.current)
    quietTimer.current = window.setTimeout(() => {
      quietTimer.current = null
      setPulseKey(0)
    }, ARRIVAL_PULSE_MS)
  }, [arrivalKey])
  useEffect(() => () => {
    if (quietTimer.current !== null) window.clearTimeout(quietTimer.current)
  }, [])

  // The unclassified bin is always visible, empty or not. It is a place you
  // put things, and a target you cannot see is a target you cannot aim at -
  // the desktop recycle bin does not vanish when you empty it either. Only the
  // documents bin hides when it holds nothing, because it is somewhere you go
  // rather than somewhere you drop.
  const showUnclassified = !readOnly || unclassified.length > 0

  return (
    <div className="ambio-bins" data-drag-active={dragActive || undefined}>
      {/* FloatingWindow portals itself out of the Floor's DOM tree - see the
          note there for why that is load-bearing rather than cosmetic. */}
      {openBin === 'unclassified' && workspaceId && (
        <BinCanvasWindow
          workspaceId={workspaceId}
          files={sorted}
          onClose={() => setOpenBin(null)}
        />
      )}

      <div className="ambio-bins__row">
        {showUnclassified && (
          <button
            key={pulseKey}
            type="button"
            className="ambio-bin ambio-bin--unclassified"
            data-arriving={pulseKey > 0 || undefined}
            data-open={openBin === 'unclassified' || undefined}
            data-receiving={dragActive || undefined}
            data-bin="unclassified"
            onClick={() => setOpenBin(current => current === 'unclassified' ? null : 'unclassified')}
            // Named for what it holds rather than for its count, which changes.
            aria-label="Unsorted files"
            aria-expanded={openBin === 'unclassified'}
            title="Files Ambio indexed but nobody has placed yet"
          >
            <BinGlyph />
            <span className="ambio-bin__count" data-empty={unclassified.length === 0 || undefined}>
              {unclassified.length}
            </span>
            <span className="ambio-bin__label">Unsorted</span>
          </button>
        )}

        {documents.length > 0 && (
          <button
            type="button"
            className="ambio-bin ambio-bin--documents"
            onClick={onToggleDocuments}
            data-open={documentsOpen || undefined}
            aria-label="Project documents"
            aria-expanded={documentsOpen}
            title="Readable documentation kept off the architecture map"
          >
            <DocumentGlyph />
            <span className="ambio-bin__count">{documents.length}</span>
            <span className="ambio-bin__label">Documents</span>
          </button>
        )}
      </div>
    </div>
  )
}

function BinGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* An inbox tray: files wait here to be placed. A trash can read as
          "deleted" for files that had only just been created. */}
      <path d="M4 13l2-8h12l2 8" />
      <path d="M4 13v6h16v-6" />
      <path d="M4 13h4l1.5 2.5h5L16 13h4" />
    </svg>
  )
}

function DocumentGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  )
}
