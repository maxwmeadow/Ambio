import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSheetStore } from '../store/sheetStore'
import { useGraphStore } from '../store/graphStore'
import { raiseFailure } from '../store/interruptionStore'
import { relationshipVerb, useSheetView } from '../canvas/sheetView'
import { useShowOnMap } from '../canvas/useShowOnMap'

/** One thing an agent proposed on the sheet, waiting for the human. */
interface ReviewItem {
  key: string
  kind: string
  name: string
  label?: string
  /** What the change is, beside its name: where a move goes, what a relationship reaches. */
  detail?: string
  relationship?: string
  focus: string
  /** Only a planned node takes a reason: it reaches the next agent session. */
  asksWhy: boolean
  decide: (decision: 'approved' | 'rejected', why?: string) => Promise<void>
}

/**
 * Everything an agent proposes arrives pending - a new system or file, an
 * existing one moved to another boundary, a new relationship - and is not part
 * of any work order until you confirm it. Each is one click either way.
 */
export function SheetProposalReview({ workspaceId }: { workspaceId: string }) {
  const sheetId = useSheetStore(s => s.activeSheetId)
  const layer = useSheetStore(s => (s.activeSheetId ? s.layersById[s.activeSheetId] : undefined))
  const { decidePlanned, decideMove, decideRename, decideRelationship } = useSheetStore(useShallow(s => ({
    decidePlanned: s.setPlannedApproval, decideMove: s.decideSheetMove, decideRename: s.decideSheetRename, decideRelationship: s.decideSheetRelationship,
  })))
  const { systems, files } = useGraphStore(useShallow(s => ({ systems: s.systems, files: s.files })))
  const [busy, setBusy] = useState(false)
  const showOnMap = useShowOnMap(false)
  // Rejecting a planned node asks why, in a line; the next agent session is told.
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  if (!sheetId || !layer) return null

  const plannedName = new Map(layer.planned.map(node => [`planned:${node.id}`, node.name]))
  const nameOf = (id: string | null | undefined): string => {
    if (!id) return 'the top level'
    return plannedName.get(id)
      ?? systems.find(system => system.id === id)?.name
      ?? files.find(file => file.id === id)?.relPath.split(/[\\/]/).pop()
      ?? 'Unavailable item'
  }
  const items: ReviewItem[] = [
    ...layer.planned.filter(node => node.approvalStatus === 'pending').map(node => ({
      key: `planned:${node.id}`, kind: 'addition', name: `Add ${node.name}`, label: node.name,
      detail: node.parentSystemId ? `in ${nameOf(node.parentSystemId)}` : undefined,
      focus: `planned:${node.id}`, asksWhy: true,
      decide: (decision: 'approved' | 'rejected', why?: string) => decidePlanned(workspaceId, node.id, decision, why),
    })),
    ...layer.elements.filter(element => element.approvalStatus === 'pending').map(element => {
      const nodeId = element.systemId ?? element.fileId ?? ''
      return {
        key: `move:${element.id}`, kind: 'move', name: `Move ${nameOf(nodeId)} into ${nameOf(element.parentSystemId)}`,
        detail: `From ${nameOf(systems.find(system => system.id === nodeId)?.parentId ?? files.find(file => file.id === nodeId)?.systemId)}`,
        focus: nodeId, asksWhy: false,
        decide: (decision: 'approved' | 'rejected') => decideMove(workspaceId, sheetId, element.id, decision),
      }
    }),
    ...layer.elements.filter(element => element.renameStatus === 'pending' && element.proposedName && element.systemId).map(element => ({
      key: `rename:${element.id}`, kind: 'rename', name: nameOf(element.systemId),
      detail: `to ${element.proposedName}`,
      focus: element.systemId!, asksWhy: false,
      decide: (decision: 'approved' | 'rejected') => decideRename(workspaceId, sheetId, element.id, decision),
    })),
    ...layer.plannedEdges.filter(edge => edge.approvalStatus === 'pending').map(edge => {
      const source = edge.srcPlanned ? `planned:${edge.srcPlanned}` : edge.srcLive ?? ''
      const target = edge.dstPlanned ? `planned:${edge.dstPlanned}` : edge.dstLive ?? ''
      return {
        key: `edge:${edge.id}`, kind: 'relationship', name: `${nameOf(source)} ${relationshipVerb(edge.kind)} ${nameOf(target)}`,
        detail: edge.note || 'Proposed relationship', relationship: edge.id,
        focus: source, asksWhy: false,
        decide: (decision: 'approved' | 'rejected') => decideRelationship(workspaceId, sheetId, edge.id, decision),
      }
    }),
  ]
  if (items.length === 0) return null

  const run = async (chosen: ReviewItem[], decision: 'approved' | 'rejected', why?: string) => {
    setBusy(true)
    try {
      for (const item of chosen) await item.decide(decision, why)
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
        <span className="ambio-sheet-rail__review-count">{items.length}</span>
        <span className="ambio-sheet-rail__section-rule" />
        {items.length > 1 && (
          <button type="button" className="ambio-sheet-rail__review-all" disabled={busy} onClick={() => void run(items, 'approved')}>Confirm all</button>
        )}
      </div>
      <ul>
        {items.map(item => (
          <li key={item.key} data-kind={item.kind}>
            <button type="button" className="ambio-sheet-rail__review-label" title={`Show ${item.label ?? item.name} on the sheet`} onClick={() => { if (item.relationship) { useGraphStore.getState().setSelectedNode(item.focus); useGraphStore.getState().setInspectedNode(null) } else showOnMap(item.focus); useSheetView.getState().focusRelationship(item.relationship ?? null) }}>
              <span>{item.name}</span>
              {item.detail && <em>{item.detail}</em>}
            </button>
            <button type="button" className="ambio-sheet-rail__review-decide" data-decision="confirm" disabled={busy} aria-label={`Confirm ${item.label ?? item.name}`} title="Confirm: part of the plan" onClick={() => void run([item], 'approved')}>✓</button>
            <button type="button" className="ambio-sheet-rail__review-decide" data-decision="reject" disabled={busy} aria-label={`Reject ${item.label ?? item.name}`} title="Reject: not part of the plan"
              onClick={() => { if (item.asksWhy) { setRejecting(item.key); setReason('') } else void run([item], 'rejected') }}>✕</button>
            {rejecting === item.key && (
              <form
                className="ambio-sheet-rail__review-reason"
                onSubmit={event => { event.preventDefault(); void run([item], 'rejected', reason) }}
              >
                <input
                  autoFocus
                  aria-label={`Why reject ${item.label ?? item.name}? (optional)`}
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
