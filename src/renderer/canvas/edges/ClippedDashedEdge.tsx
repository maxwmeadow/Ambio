import React, { useCallback, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { clipOrthogonalEdge, orthogonalLength, orthogonalPoints } from './clippedEdgeGeometry'

interface Props { id: string; path: string; markerEnd?: string; style: React.CSSProperties }
/** Only very long dashed paths react to camera movement. Short paths retain
 * their existing SVG and have a stable null viewport selector. */
export function ClippedDashedEdge({ id, path, markerEnd, style }: Props) {
  const points = useMemo(() => orthogonalPoints(path), [path])
  const length = useMemo(() => points ? orthogonalLength(points) : 0, [points])
  const viewport = useStore(useShallow(useCallback(state => length * state.transform[2] > 8192
    ? { x: state.transform[0], y: state.transform[1], zoom: state.transform[2], width: state.width, height: state.height }
    : null, [length])))
  // Current arrowheads are 18 units. Allow for marker/stroke extent at extreme
  // zoom as well as an extra screen buffer, so clipping cannot reveal a cut.
  const padding = 64 + 64 * (viewport?.zoom ?? 1)
  const parts = viewport && points ? clipOrthogonalEdge(points, {
    x: (-viewport.x - padding) / viewport.zoom, y: (-viewport.y - padding) / viewport.zoom,
    width: (viewport.width + 2 * padding) / viewport.zoom, height: (viewport.height + 2 * padding) / viewport.zoom,
  }) : [{ path, startLength: 0, endsAtTarget: true }]
  const offset = Number.parseFloat(String(style.strokeDashoffset ?? 0)) || 0
  return <>{parts.map((part, index) => <React.Fragment key={index}>
    <path id={index ? `${id}-part-${index}` : id} d={part.path} className="react-flow__edge-path" fill="none"
      markerEnd={part.endsAtTarget ? markerEnd : undefined} strokeWidth={1}
      // Flow scales an HTML camera around the SVG. Dash phase remains in path
      // coordinates, including for its non-scaling-stroke styles.
      style={{ ...style, strokeDashoffset: offset + part.startLength }} />
    <path d={part.path} className="react-flow__edge-interaction" fill="none" stroke="transparent"
      strokeWidth={12} style={{ cursor: 'pointer' }} />
  </React.Fragment>)}</>
}
