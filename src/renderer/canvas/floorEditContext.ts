import { createContext, useContext } from 'react'

/**
 * Meaning edits the live Floor offers to its nodes. Provided only where the
 * Floor is editable (not on a sheet, in a review, a read-only view or the
 * unsorted bin), so a node that finds no provider simply is not editable.
 *
 * A context rather than per-node callbacks: putting a fresh handler into
 * every node's data would re-render the whole map on each projection.
 */
export interface FloorEdits {
  /** Whether this id is a live system you may rename. */
  canRename: (id: string) => boolean
  renameSystem: (id: string, name: string) => void
}

export const FloorEditContext = createContext<FloorEdits | null>(null)

export function useFloorEdits(): FloorEdits | null {
  return useContext(FloorEditContext)
}
