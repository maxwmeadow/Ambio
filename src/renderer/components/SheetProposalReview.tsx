import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSheetStore } from '../store/sheetStore'
import { useGraphStore } from '../store/graphStore'
import { relationshipVerb, useSheetView } from '../canvas/sheetView'
import { useShowOnMap } from '../canvas/useShowOnMap'
import { sheetReviewGroups } from './sheetReviewGroups'

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
  source?: string
  target?: string
  /** Node/connection decisions carry the change request to the next session. */
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
  const { decidePlanned, decideMove, decideRename, decideRelationship, reviewProposals } = useSheetStore(useShallow(s => ({
    decidePlanned: s.setPlannedApproval, decideMove: s.decideSheetMove, decideRename: s.decideSheetRename, decideRelationship: s.decideSheetRelationship,
    reviewProposals: s.reviewSheetProposals,
  })))
  const { systems, files } = useGraphStore(useShallow(s => ({ systems: s.systems, files: s.files })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const showOnMap = useShowOnMap(false)
  // Keep the exact selected scope and revision while the person explains why.
  const [rejecting, setRejecting] = useState<{ key: string; items: ReviewItem[]; revision: number } | null>(null)
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
        source, target,
        focus: source, asksWhy: true,
        decide: (decision: 'approved' | 'rejected') => decideRelationship(workspaceId, sheetId, edge.id, decision),
      }
    }),
  ]
  if (items.length === 0) return null

  const groups = sheetReviewGroups(items, layer.planned)
  const run = async (chosen: ReviewItem[], decision: 'approved' | 'rejected', why?: string, revision = layer.sheet.revision) => {
    setBusy(true)
    setError('')
    try {
      if (chosen.every(item => item.kind === 'addition' || item.kind === 'relationship')) {
        await reviewProposals(workspaceId, sheetId, revision, chosen.map(item => ({ kind: item.kind, id: item.key.slice(item.key.indexOf(':') + 1) })), decision, why)
      } else {
        for (const item of chosen) await item.decide(decision, why)
      }
      setRejecting(null)
      setReason('')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="ambio-sheet-rail__review" aria-label="Agent proposals to review">
      <div className="ambio-sheet-rail__section-label ambio-sheet-rail__review-heading">
        <span>To review</span>
        <span className="ambio-sheet-rail__review-count" aria-label={`${groups.length} ${groups.length === 1 ? 'change' : 'changes'} to review`}>{groups.length}</span>
        <span className="ambio-sheet-rail__section-rule" />
      </div>
      <ul>
        {groups.map(group => <li className="ambio-sheet-review-group" key={group.key}>
          <button type="button" className="ambio-sheet-rail__review-label" onClick={() => showOnMap(group.focus)} title="Show proposed change">
            <span>{group.name}</span>
            {layer.planned.find(node => `planned:${node.id}` === group.focus)?.parentSystemId && <em>in {nameOf(layer.planned.find(node => `planned:${node.id}` === group.focus)?.parentSystemId)}</em>}
          </button>
          <details className="ambio-sheet-review-details">
            <summary>{group.items.length} {group.items.length === 1 ? 'detail' : 'details'}{group.external > 0 ? ` · ${group.external} outside ${group.external === 1 ? 'connection' : 'connections'}` : ''}</summary>
            <ul aria-label={`Details of ${group.name}`}>
        {group.items.map(item => (
          <li key={item.key} data-kind={item.kind}>
            <button type="button" className="ambio-sheet-rail__review-label" title={`Show ${item.label ?? item.name} on the sheet`} onClick={() => { if (item.relationship) { useGraphStore.getState().setSelectedNode(item.focus); useGraphStore.getState().setInspectedNode(null) } else showOnMap(item.focus); useSheetView.getState().focusRelationship(item.relationship ?? null) }}>
              <span>{item.name}</span>
              {item.detail && <em>{item.detail}</em>}
            </button>
            <button type="button" className="ambio-sheet-rail__review-decide" data-decision="confirm" disabled={busy} aria-label={`Confirm ${item.label ?? item.name}`} title="Confirm: part of the plan" onClick={() => void run([item], 'approved')}>✓</button>
            <button type="button" className="ambio-sheet-rail__review-decide" data-decision="reject" disabled={busy} aria-label={`Reject ${item.label ?? item.name}`} title="Reject: not part of the plan"
              onClick={() => { if (!item.asksWhy) { void run([item], 'rejected'); return }; setRejecting({ key: group.key, items: [item], revision: layer.sheet.revision }); setReason('') }}>✕</button>
          </li>
        ))}
            </ul>
          </details>
          <div className="ambio-sheet-review-actions">
            <button type="button" disabled={busy} aria-label={`Approve ${group.name}`} onClick={() => void run(group.items, 'approved')}>Approve</button>
            <button type="button" disabled={busy} onClick={() => { if (!group.items.some(item => item.asksWhy)) { void run(group.items, 'rejected'); return }; setRejecting({ key: group.key, items: group.items, revision: layer.sheet.revision }); setReason('') }}>{group.items.some(item => item.asksWhy) ? 'Request changes' : 'Reject'}</button>
          </div>
          {rejecting?.key === group.key && <form className="ambio-sheet-rail__review-reason" onSubmit={event => { event.preventDefault(); void run(rejecting.items, 'rejected', reason, rejecting.revision) }}>
            <input autoFocus aria-label="What should change?" placeholder="What should change?" value={reason} maxLength={300} onChange={event => setReason(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setRejecting(null) }} />
            <button type="submit" disabled={busy || !reason.trim()}>Send</button>
            <button type="button" disabled={busy} onClick={() => setRejecting(null)}>Cancel</button>
          </form>}
        </li>)}
      </ul>
      {error && <p className="ambio-sheet-review-error" role="alert">{error}</p>}
    </section>
  )
}
