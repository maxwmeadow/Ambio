/** Counter-scaled by canvasZoomChrome, without restyling the node body. */
const LABELS: Record<string, string> = { addition: 'Added', move: 'Moved', rename: 'Renamed', 'move rename': 'Moved + renamed' }

export function SheetChangeBadge({ change, width }: { change: unknown; width: number }) {
  const label = typeof change === 'string' ? LABELS[change] : undefined
  if (!label) return null
  return <span className="ambio-sheet-change-badge" style={{ '--sheet-frame-width': width } as React.CSSProperties}>{label}</span>
}
