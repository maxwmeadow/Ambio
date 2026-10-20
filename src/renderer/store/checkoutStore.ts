import { create } from 'zustand'
import type { CheckoutsSnapshot } from '../../shared/types'
import { apiGetCheckouts } from '../canvas/arcdApi.ts'
import {
  buildCanvasOverlay,
  collisionsBySystem,
  DEFAULT_OVERLAY_LENS,
  type OverlayArrival,
  type OverlayLens,
  type OverlayMark,
  type SystemCollisionBranch,
} from '../components/checkoutModel.ts'

/**
 * Every checkout of the open project, as GET /api/checkouts reports it. The
 * branch chip, the Checkouts popover, collision marks on systems, other
 * checkouts' overlays and the Properties section all read this one snapshot.
 */
interface CheckoutState {
  workspaceId: string
  snapshot: CheckoutsSnapshot | null
  lens: OverlayLens
  /** Derived once per snapshot, each entry kept by reference while it is
   *  unchanged, so a poll that finds nothing new re-renders no node. */
  bySystem: Map<string, SystemCollisionBranch[]>
  overlayByFile: Map<string, OverlayMark[]>
  arrivals: Map<string, OverlayArrival[]>
  unplaced: number
  refresh: (workspaceId: string) => Promise<void>
  setLens: (lens: OverlayLens) => void
}

/** Registered in projectLocalState so deleting a project forgets it. */
export const OVERLAY_LENS_KEY = (projectId: string) => `checkout_lens_${projectId}`

function readLens(workspaceId: string): OverlayLens {
  try {
    const stored = localStorage.getItem(OVERLAY_LENS_KEY(workspaceId))
    if (stored === 'off' || stored === 'agents' || stored === 'all') return stored
  } catch { /* storage may be unavailable */ }
  return DEFAULT_OVERLAY_LENS
}

function keepUnchanged<T>(previous: Map<string, T>, next: Map<string, T>): Map<string, T> {
  for (const [key, value] of next) {
    const prior = previous.get(key)
    if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(value)) next.set(key, prior)
  }
  return next
}

function derived(
  state: Pick<CheckoutState, 'bySystem' | 'overlayByFile' | 'arrivals'>,
  snapshot: CheckoutsSnapshot | null,
  lens: OverlayLens,
) {
  const overlay = buildCanvasOverlay(snapshot, lens)
  return {
    bySystem: keepUnchanged(state.bySystem, collisionsBySystem(snapshot)),
    overlayByFile: keepUnchanged(state.overlayByFile, overlay.byFile),
    arrivals: keepUnchanged(state.arrivals, overlay.arrivals),
    unplaced: overlay.unplaced,
  }
}

let inFlight: { workspaceId: string; request: Promise<void> } | null = null

export const useCheckoutStore = create<CheckoutState>((set, get) => ({
  workspaceId: '',
  snapshot: null,
  lens: DEFAULT_OVERLAY_LENS,
  bySystem: new Map(),
  overlayByFile: new Map(),
  arrivals: new Map(),
  unplaced: 0,
  refresh: async (workspaceId: string) => {
    if (get().workspaceId !== workspaceId) {
      set({
        workspaceId, snapshot: null, lens: readLens(workspaceId),
        bySystem: new Map(), overlayByFile: new Map(), arrivals: new Map(), unplaced: 0,
      })
    }
    if (!workspaceId) return
    if (inFlight?.workspaceId === workspaceId) return inFlight.request
    const request = apiGetCheckouts(workspaceId)
      .then(snapshot => {
        const state = get()
        if (state.workspaceId === workspaceId) set({ snapshot, ...derived(state, snapshot, state.lens) })
      })
      .catch((error: unknown) => {
        console.warn('[checkouts] refresh failed:', error instanceof Error ? error.message : error)
      })
      .finally(() => {
        if (inFlight?.request === request) inFlight = null
      })
    inFlight = { workspaceId, request }
    return request
  },
  setLens: (lens: OverlayLens) => {
    const state = get()
    try { localStorage.setItem(OVERLAY_LENS_KEY(state.workspaceId), lens) } catch { /* this window only, then */ }
    set({ lens, ...derived(state, state.snapshot, lens) })
  },
}))

/** Asks the branch chip to open a branch's review: detail {rootId, name}. */
export const REVIEW_BRANCH = 'ambio:review-branch'

/** Dispatched when archd reports that checkouts, branches or heads changed. */
export const CHECKOUTS_CHANGED = 'ambio:checkouts-changed'
