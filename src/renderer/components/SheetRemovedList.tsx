import { restoreSheetRemoval, useSheetStore } from '../store/sheetStore'
import { raiseFailure } from '../store/interruptionStore'

/**
 * Every removal stays listed on the sheet that made it, restorable long
 * afterwards (contract: "a removal is always recoverable, and not through
 * undo"). One whose code has since gone is kept and marked, never dropped.
 */
export function SheetRemovedList({ workspaceId }: { workspaceId: string }) {
  const sheetId = useSheetStore(s => s.activeSheetId)
  const removals = useSheetStore(s => (s.activeSheetId ? s.layersById[s.activeSheetId]?.removals : undefined))
  if (!sheetId || !removals?.length) return null
  return (
    <section className="ambio-sheet-rail__removed" aria-label="Removed on this sheet">
      <div className="ambio-sheet-rail__removed-heading">Removed on this sheet · {removals.length}</div>
      <ul>
        {removals.map(removal => (
          <li key={removal.nodeId} data-done={removal.done ? 'true' : undefined}>
            <span className="ambio-sheet-rail__removed-label" title={removal.label}>{removal.label}</span>
            {removal.done
              ? <span className="ambio-sheet-rail__removed-done" title="This code is gone">GONE</span>
              : (
                <button
                  type="button"
                  aria-label={`Restore ${removal.label}`}
                  title="Take this removal off the sheet"
                  onClick={() => {
                    void restoreSheetRemoval(workspaceId, sheetId, removal.nodeId)
                      .catch(error => raiseFailure('sheet-removal-restore', "Couldn't restore", String(error)))
                  }}
                >
                  Restore
                </button>
              )}
          </li>
        ))}
      </ul>
    </section>
  )
}
