import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { plannedMetadata, useSheetStore, type SheetLayerData } from '../store/sheetStore'
import { useGraphStore } from '../store/graphStore'
import { relationshipVerb, useSheetView } from '../canvas/sheetView'
import { useShowOnMap } from '../canvas/useShowOnMap'
import { sheetReviewGroups } from './sheetReviewGroups'
import { plannedDescription, plannedFilename } from '../canvas/plannedFileIdentity'

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
  const layer = useSheetStore(s => (s.activeSheetId ? s.layersById[s.activeSheetId] : undefined))
  const current = useMemo(() => layer?.sheet.workspaceId === workspaceId && (
    layer.planned.some(node => node.approvalStatus === 'pending') ||
    layer.elements.some(element => element.approvalStatus === 'pending' || element.renameStatus === 'pending' && element.proposedName && element.systemId) ||
    layer.plannedEdges.some(edge => edge.approvalStatus === 'pending')
  ) ? { layer, workspaceId } : null, [layer, workspaceId])
  const [retained, setRetained] = useState(current)
  const root = useRef<HTMLElement>(null)
  const latest = useRef(current)
  latest.current = current
  const shown = current ?? (retained?.workspaceId === workspaceId ? retained : null)
  useLayoutEffect(() => {
    if (current && current !== retained) setRetained(current)
    else if (retained && retained.workspaceId !== workspaceId) setRetained(null)
  }, [current, retained, workspaceId])
  useLayoutEffect(() => {
    const node = root.current
    if (current || !shown || !node) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reducedMotion.matches) {
      setRetained(null)
      return
    }
    const appearance = () => {
      const style = getComputedStyle(node)
      return { height: style.height, opacity: style.opacity, transform: style.transform,
        clipPath: style.clipPath === 'none' ? 'inset(0)' : style.clipPath,
        paddingBottom: style.paddingBottom, borderTopWidth: style.borderTopWidth }
    }
    const start = appearance()
    for (const animation of node.getAnimations()) animation.cancel()
    const exit = node.animate([start, { height: '0px', opacity: 0, transform: 'translateY(10px)',
      clipPath: 'inset(100% 0 0)', paddingBottom: '0px', borderTopWidth: '0px' }],
    { duration: 220, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' })
    void exit.finished.then(() => setRetained(null), () => {})
    const skipMotion = () => { if (reducedMotion.matches) setRetained(null) }
    reducedMotion.addEventListener('change', skipMotion)
    return () => {
      reducedMotion.removeEventListener('change', skipMotion)
      const interrupted = exit.playState !== 'finished'
      const partial = appearance()
      exit.cancel()
      // Reopening the same sheet reverses the exit rather than jumping full size.
      if (interrupted && node.isConnected && latest.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        node.animate([partial, appearance()], { duration: 180, easing: 'cubic-bezier(.22, 1, .36, 1)' })
      }
    }
  }, [current, shown])
  return shown ? <SheetReviewContent key={`${shown.workspaceId}:${shown.layer.sheet.id}`} workspaceId={shown.workspaceId} layer={shown.layer} closing={!current} root={root} /> : null
}

/** The last layer remains visible, but inert, while its review closes. */
function SheetReviewContent({ workspaceId, layer, closing, root }: { workspaceId: string; layer: SheetLayerData; closing: boolean; root: RefObject<HTMLElement> }) {
  const sheetId = layer.sheet.id
  useLayoutEffect(() => { root.current?.toggleAttribute('inert', closing) }, [closing, root])
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
  const [inspecting, setInspecting] = useState<string | null>(null)
  const inspectButton = useRef<HTMLButtonElement | null>(null)

  const plannedName = new Map(layer.planned.map(node => [`planned:${node.id}`, node.kind === 'file' ? plannedFilename(node) : node.name]))
  const nameOf = (id: string | null | undefined): string => {
    if (!id) return 'the top level'
    return plannedName.get(id)
      ?? systems.find(system => system.id === id)?.name
      ?? files.find(file => file.id === id)?.relPath.split(/[\\/]/).pop()
      ?? 'Unavailable item'
  }
  const items: ReviewItem[] = [
    ...layer.planned.filter(node => node.approvalStatus === 'pending').map(node => ({
      key: `planned:${node.id}`, kind: 'addition', name: `Add ${nameOf(`planned:${node.id}`)}`, label: nameOf(`planned:${node.id}`),
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
  const requestChanges = (key: string, chosen: ReviewItem[]) => {
    if (!chosen.some(item => item.asksWhy)) { void run(chosen, 'rejected'); return }
    if (inspecting) setInspecting(key)
    setRejecting({ key, items: chosen, revision: layer.sheet.revision }); setReason('')
  }
  const reasonForm = (key: string) => rejecting?.key === key && <form className="ambio-sheet-rail__review-reason" onSubmit={event => { event.preventDefault(); void run(rejecting.items, 'rejected', reason, rejecting.revision) }}>
    <input autoFocus disabled={closing} aria-label="What should change?" placeholder="What should change?" value={reason} maxLength={300} onChange={event => setReason(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setRejecting(null) } }} />
    <button type="submit" disabled={busy || closing || !reason.trim()}>Send</button>
    <button type="button" disabled={busy || closing} onClick={() => setRejecting(null)}>Cancel</button>
  </form>
  const actions = (group: typeof groups[number]) => <div className="ambio-sheet-review-actions">
    <button type="button" disabled={busy || closing} aria-label={`Approve ${group.name}`} onClick={() => void run(group.items, 'approved')}>Approve</button>
    <button type="button" disabled={busy || closing} onClick={() => requestChanges(group.key, group.items)}>{group.items.some(item => item.asksWhy) ? 'Request changes' : 'Reject'}</button>
  </div>
  const inspected = groups.find(group => group.key === inspecting)
  return <>
    <section ref={root} className="ambio-sheet-rail__review" data-exiting={closing || undefined} aria-hidden={closing || undefined} aria-label="Agent proposals to review">
      <div className="ambio-sheet-rail__section-label ambio-sheet-rail__review-heading">
        <span>To review</span>
        <span className="ambio-sheet-rail__review-count" aria-label={`${groups.length} ${groups.length === 1 ? 'change' : 'changes'} to review`}>{groups.length}</span>
        <span className="ambio-sheet-rail__section-rule" />
      </div>
      <ul>
        {groups.map(group => {
          const additions = group.items.filter(item => item.kind === 'addition')
          const kinds = new Map<string, number>()
          for (const item of additions) {
            const kind = layer.planned.find(node => `planned:${node.id}` === item.focus)?.kind ?? 'element'
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
          }
          const counts = [...kinds].map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : kind === 'class' ? 'es' : 's'}`)
          if (group.connections) counts.push(`${group.connections} ${group.connections === 1 ? 'connection' : 'connections'}`)
          const root = layer.planned.find(node => `planned:${node.id}` === group.focus)
          const description = root ? plannedDescription(root, plannedMetadata(root)) : ''
          return <li className="ambio-sheet-review-group" key={group.key}>
            <button type="button" disabled={closing} className="ambio-sheet-rail__review-label" onClick={() => showOnMap(group.focus)} title="Show proposed change"><span>{group.name}</span></button>
            {counts.length > 0 && <p className="ambio-sheet-review-summary">{counts.join(', ')}</p>}
            {description && <p className="ambio-sheet-review-intent" title={description}>{description}</p>}
            <button type="button" disabled={closing} className="ambio-sheet-review-inspect" aria-label={`Inspect changes for ${group.name}`} onClick={event => { inspectButton.current = event.currentTarget; setInspecting(group.key); showOnMap(group.focus) }}>Inspect changes <span aria-hidden="true">→</span></button>
            {actions(group)}
            {!inspected && reasonForm(group.key)}
          </li>
        })}
      </ul>
      {error && <p className="ambio-sheet-review-error" role="alert">{error}</p>}
    </section>
    {!closing && inspected && <ReviewInspector title={inspected.name} onClose={() => { setInspecting(null); inspectButton.current?.focus() }}>
      <p className="ambio-sheet-review-panel__context">{layer.sheet.name}</p>
      {(['addition', 'relationship', 'move', 'rename'] as const).map(kind => {
        const chosen = inspected.items.filter(item => item.kind === kind)
        if (!chosen.length) return null
        return <section key={kind} aria-label={kind === 'addition' ? 'Additions' : kind === 'relationship' ? 'Connections' : kind === 'move' ? 'Moves' : 'Renames'}>
          <h3>{kind === 'addition' ? 'Additions' : kind === 'relationship' ? 'Connections' : kind === 'move' ? 'Moves' : 'Renames'} <span>{chosen.length}</span></h3>
          <ul aria-label={`${kind} details of ${inspected.name}`}>
            {chosen.map(item => <li key={item.key} data-kind={item.kind}>
              <button type="button" className="ambio-sheet-rail__review-label" title={`Show ${item.label ?? item.name} on the sheet`} onClick={() => { if (item.relationship) { useGraphStore.getState().setSelectedNode(item.focus); useGraphStore.getState().setInspectedNode(null) } else showOnMap(item.focus); useSheetView.getState().focusRelationship(item.relationship ?? null) }}>
                <span>{item.name}</span>{item.detail && <em>{item.detail}</em>}
              </button>
              <button type="button" className="ambio-sheet-rail__review-decide" disabled={busy} aria-label={`Confirm ${item.label ?? item.name}`} title="Confirm: part of the plan" onClick={() => void run([item], 'approved')}>✓</button>
              <button type="button" className="ambio-sheet-rail__review-decide" disabled={busy} aria-label={`Reject ${item.label ?? item.name}`} title="Reject: not part of the plan" onClick={() => requestChanges(inspected.key, [item])}>✕</button>
            </li>)}
          </ul>
        </section>
      })}
      <footer>{actions(inspected)}{reasonForm(inspected.key)}{error && <p className="ambio-sheet-review-error" role="alert">{error}</p>}</footer>
    </ReviewInspector>}
  </>
}

/** A nonmodal inspector leaves the map available while examining a proposal. */
function ReviewInspector({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    close.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onCloseRef.current() }
    }
    // Inputs handle Escape locally before the inspector closes.
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [])
  return createPortal(<aside className="ambio-sheet-review-panel" role="dialog" aria-label={`Review ${title}`}>
    <header><div><small>Review changes</small><h2>{title}</h2></div><button ref={close} type="button" aria-label="Close change review" onClick={onClose}>×</button></header>
    <div className="ambio-sheet-review-panel__body">{children}</div>
  </aside>, document.body)
}
