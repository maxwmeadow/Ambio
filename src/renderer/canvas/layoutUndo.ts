import type { FloorLayout } from '../../shared/types'
import type { UndoEntry } from './undoStack.ts'

/**
 * Edit → Undo for moving and resizing on the Floor. Placement is your
 * presentation, so undoing it puts the rows back where they were; nothing is
 * journaled. Only rows that had a saved place before can be put back, so a
 * gesture that placed a node for the first time is not undoable for it.
 */
type LayoutRow = Omit<FloorLayout, 'workspaceId' | 'updatedAt'>

const key = (row: Pick<FloorLayout, 'nodeType' | 'nodeId'>) => `${row.nodeType}:${row.nodeId}`

export function layoutUndoEntry(input: {
  label: string
  before: LayoutRow[]
  after: LayoutRow[]
  /** Shows the rows at once and saves them; rejects when archd refuses. */
  save: (rows: LayoutRow[]) => Promise<void>
}): UndoEntry | null {
  const known = new Set(input.before.map(key))
  const after = input.after.filter(row => known.has(key(row)))
  const changed = after.some(row => {
    const previous = input.before.find(item => key(item) === key(row))!
    return previous.positionX !== row.positionX || previous.positionY !== row.positionY ||
      previous.width !== row.width || previous.height !== row.height || previous.parentNodeId !== row.parentNodeId
  })
  if (!changed) return null
  const before = input.before.map(({ workspaceId: _w, updatedAt: _u, ...row }: FloorLayout | LayoutRow & { workspaceId?: string; updatedAt?: number }) => row as LayoutRow)
  return {
    label: input.label,
    undo: () => input.save(before),
    redo: () => input.save(after),
  }
}
