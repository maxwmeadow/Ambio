import { useState } from 'react'
import { useSheetStore } from '../store/sheetStore'
import { raiseFailure } from '../store/interruptionStore'
import { useShowOnMap } from '../canvas/useShowOnMap'

/**
 * An agent's planned elements arrive pending: they are drawn, but not part of
 * any work order until you confirm them. Each is one click either way.
 */
export function SheetProposalReview({ workspaceId }: { workspaceId: string }) {
  const sheetId = useSheetStore(s => s.activeSheetId)
  const planned = useSheetStore(s => (s.activeSheetId ? s.layersById[s.activeSheetId]?.planned : undefined))
  const pending = (planned ?? []).filter(node => node.approvalStatus === 'pending')
  const decide = useSheetStore(s => s.setPlannedApproval)
  const [busy, setBusy] = useState(false)
  const showOnMap = useShowOnMap()
  // Rejecting asks why, in a line; the next agent session is told.
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  if (!sheetId || pending.length === 0) return null
  const run = async (ids: string[], decision: 'approved' | 'rejected', why?: string) => {
    setBusy(true)
    try {
      for (const id of ids) await decide(workspaceId, id, decision, why)
      setRejecting(null)
      setReason('')
    } catch (error) {
      raiseFailure('proposal-review', decision === 'approved' ? "Couldn't confirm" : "Couldn't reject", String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="ambio-sheet-rail__review" aria-label="Agent proposals to review">
      <div className="ambio-sheet-rail__section-label ambio-sheet-rail__review-heading">
        <span>To review</span>
        <span className="ambio-sheet-rail__review-count">{pending.length}</span>
        <span className="ambio-sheet-rail__section-rule" />
        {pending.length > 1 && (
          <button type="button" className="ambio-sheet-rail__review-all" disabled={busy} onClick={() => void run(pending.map(node => node.id), 'approved')}>Confirm all</button>
        )}
      </div>
      <ul>
        {pending.map(node => (
          <li key={node.id}>
            <button type="button" className="ambio-sheet-rail__review-label" title={`Show ${node.name} on the sheet`} onClick={() => showOnMap(`planned:${node.id}`)}>
              <small>{node.kind}</small>
              <span>{node.name}</span>
            </button>
            <button type="button" className="ambio-sheet-rail__review-decide" data-decision="confirm" disabled={busy} aria-label={`Confirm ${node.name}`} title="Confirm: part of the plan" onClick={() => void run([node.id], 'approved')}>✓</button>
            <button type="button" className="ambio-sheet-rail__review-decide" data-decision="reject" disabled={busy} aria-label={`Reject ${node.name}`} title="Reject: not part of the plan" onClick={() => { setRejecting(node.id); setReason('') }}>✕</button>
            {rejecting === node.id && (
              <form
                className="ambio-sheet-rail__review-reason"
                onSubmit={event => { event.preventDefault(); void run([node.id], 'rejected', reason) }}
              >
                <input
                  autoFocus
                  aria-label={`Why reject ${node.name}? (optional)`}
                  placeholder="Why? (optional, the agent is told)"
                  value={reason}
                  maxLength={300}
                  onChange={event => setReason(event.target.value)}
                  onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setRejecting(null) }}
                />
                <button type="submit" disabled={busy}>Reject</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
