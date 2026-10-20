import { create } from 'zustand'
import type { CheckoutsSnapshot } from '../../shared/types'
import { apiGetCheckouts } from '../canvas/arcdApi.ts'
import { collisionsBySystem, type SystemCollisionBranch } from '../components/checkoutModel.ts'

/**
 * Every checkout of the open project, as GET /api/checkouts reports it. The
 * branch chip, the Checkouts popover, collision marks on systems and the
 * Properties section all read this one snapshot.
 */
interface CheckoutState {
  workspaceId: string
  snapshot: CheckoutsSnapshot | null
  /** Systems more than one checkout is changing; derived once per snapshot so
   *  each system node selects a stable value. */
  bySystem: Map<string, SystemCollisionBranch[]>
  refresh: (workspaceId: string) => Promise<void>
}

/** Reuses the previous list for a system whose collision did not change, so a
 *  poll that finds nothing new re-renders no system node. */
function keepUnchanged(
  previous: Map<string, SystemCollisionBranch[]>,
  next: Map<string, SystemCollisionBranch[]>,
): Map<string, SystemCollisionBranch[]> {
  for (const [systemId, branches] of next) {
    const prior = previous.get(systemId)
    if (prior && JSON.stringify(prior) === JSON.stringify(branches)) next.set(systemId, prior)
  }
  return next
}

let inFlight: { workspaceId: string; request: Promise<void> } | null = null

export const useCheckoutStore = create<CheckoutState>((set, get) => ({
  workspaceId: '',
  snapshot: null,
  bySystem: new Map(),
  refresh: async (workspaceId: string) => {
    if (get().workspaceId !== workspaceId) set({ workspaceId, snapshot: null, bySystem: new Map() })
    if (!workspaceId) return
    if (inFlight?.workspaceId === workspaceId) return inFlight.request
    const request = apiGetCheckouts(workspaceId)
      .then(snapshot => {
        if (get().workspaceId === workspaceId) set({ snapshot, bySystem: keepUnchanged(get().bySystem, collisionsBySystem(snapshot)) })
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
}))

/** Dispatched when archd reports that checkouts, branches or heads changed. */
export const CHECKOUTS_CHANGED = 'ambio:checkouts-changed'
