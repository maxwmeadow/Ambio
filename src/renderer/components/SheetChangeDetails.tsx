import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'
import { relationshipVerb, useSheetView } from '../canvas/sheetView'

/** Meaning appears on selection, while the overview stays quiet. */
export function SheetChangeDetails() {
  const selected = useGraphStore(s => s.selectedNodeId)
  const systems = useGraphStore(s => s.systems)
  const files = useGraphStore(s => s.files)
  const layer = useSheetStore(s => s.activeSheetId ? s.layersById[s.activeSheetId] : undefined)
  const relationship = useSheetView(s => s.relationship)
  if (!layer) return null
  const nameOf = (id: string | null | undefined): string => !id ? 'the top level'
    : layer.planned.find(node => `planned:${node.id}` === id)?.name
      ?? systems.find(node => node.id === id)?.name
      ?? files.find(node => node.id === id)?.relPath.split(/[\\/]/).pop() ?? 'Unavailable item'
  const edge = layer.plannedEdges.find(edge => edge.id === relationship && edge.approvalStatus !== 'rejected')
  const source = edge?.srcLive ?? (edge?.srcPlanned ? `planned:${edge.srcPlanned}` : null)
  const target = edge?.dstLive ?? (edge?.dstPlanned ? `planned:${edge.dstPlanned}` : null)
  if (edge && (selected === source || selected === target)) return <section className="ambio-sheet-change" aria-label="Selected relationship">
    <strong>{nameOf(source)} {relationshipVerb(edge.kind)} {nameOf(target)}</strong>
    {edge.note && <p>{edge.note}</p>}
    <small>{edge.approvalStatus === 'pending' ? 'Proposed relationship · needs your review' : 'Part of this plan'}</small>
  </section>
  const move = layer.elements.find(element => (element.systemId ?? element.fileId) === selected && element.approvalStatus !== 'rejected')
  const original = systems.find(node => node.id === selected)?.parentId ?? files.find(node => node.id === selected)?.systemId ?? null
  const layout = layer.layouts.find(row => row.nodeId === selected)
  const proposed = layout ? layout.parentNodeId : move?.parentSystemId
  if (move && original !== proposed) return <section className="ambio-sheet-change" aria-label="Selected change">
    <strong>Move {nameOf(selected)}</strong><p>From {nameOf(original)} to {nameOf(proposed)}</p>
  </section>
  return null
}
