/** Counter-scaled by canvasZoomChrome, without restyling the node body. */
export function SheetChangeBadge({ change, width }: { change: unknown; width: number }) {
  if (change !== 'move' && change !== 'addition') return null
  return <span className="ambio-sheet-change-badge" style={{ '--sheet-frame-width': width } as React.CSSProperties}>{change === 'move' ? 'Moved' : 'Added'}</span>
}
