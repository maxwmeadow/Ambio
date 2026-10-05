import React from 'react'
import { getBezierPath, Position, ViewportPortal, useViewport, type Node } from '@xyflow/react'

import { absoluteRects, bodyRect, folderTabOf } from './folderAnchors.ts'
import { chooseClosestLivingBoundaryAnchors, type LivingAnchorSide, type LivingRect } from './livingEdgeGeometry.ts'
import { livingVisibilityIndex, type LivingVisibilityOptions } from './livingVisibility.ts'
import {
  calloutScreenSize,
  mergeTraceLines,
  placeCallout,
  type Box,
  type RunCallout,
  type TraceStepLike,
} from './runTraceProjection.ts'

interface RunTraceOverlayProps {
  steps: readonly TraceStepLike[] | null
  callouts: readonly RunCallout[]
  nodes: Node[]
  visibilityOptions: LivingVisibilityOptions
}

const positionBySide: Record<LivingAnchorSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

/** Screen-pixel gap between a box and its callout. */
const CALLOUT_GAP = 10

/**
 * A call path or an investigation run, drawn over the Floor.
 *
 * Lines are ink curves between the boxes you can actually see, one per pair,
 * meeting each system on its folder body rather than its tab. Direction is
 * carried by the dash flowing caller to callee: the canvas contract gives
 * living and trace flows no arrowheads. Labels and
 * callouts are sized in screen pixels (counter-scaled against the zoom) so
 * they read the same at every zoom instead of shrinking to specks the moment
 * the camera pulls back to show the whole path.
 */
export function RunTraceOverlay({ steps, callouts, nodes, visibilityOptions }: RunTraceOverlayProps) {
  const { zoom } = useViewport()
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1

  const scene = React.useMemo(() => {
    if ((!steps || steps.length === 0) && callouts.length === 0) return null
    const visibility = livingVisibilityIndex(nodes, visibilityOptions)
    const rects = absoluteRects(nodes)
    const byId = new Map(nodes.map(node => [node.id, node]))
    const bodyOf = (id: string): LivingRect | null => {
      const rect = rects.get(id)
      const node = byId.get(id)
      return rect && node ? bodyRect(rect, folderTabOf(node)) : null
    }

    const lines = mergeTraceLines(steps ?? [], visibility.visibleNodeId).flatMap(line => {
      const source = bodyOf(line.source)
      const target = bodyOf(line.target)
      if (!source || !target) return []
      const anchors = chooseClosestLivingBoundaryAnchors(source, target)
      const from = clearOfTab(anchors.source, anchors.sourceSide, line.source)
      const to = clearOfTab(anchors.target, anchors.targetSide, line.target)
      const [path, labelX, labelY] = getBezierPath({
        sourceX: from.x,
        sourceY: from.y,
        sourcePosition: positionBySide[anchors.sourceSide],
        targetX: to.x,
        targetY: to.y,
        targetPosition: positionBySide[anchors.targetSide],
      })
      return [{ ...line, path, labelX, labelY, from, to }]
    })

    // Top-anchored lines must not land on the part of the body's top edge the
    // tab sits on.
    function clearOfTab(point: { x: number; y: number }, side: LivingAnchorSide, id: string) {
      if (side !== 'top') return point
      const node = byId.get(id)
      const rect = rects.get(id)
      const tab = node ? folderTabOf(node) : null
      if (!tab || !rect) return point
      const min = rect.x + Math.min(rect.width, tab.exposedFrom + 12)
      return { x: Math.min(rect.x + rect.width, Math.max(point.x, min)), y: point.y }
    }

    // Each callout hugs the box showing its file, on whichever side covers
    // least of the other boxes and of callouts already placed.
    const visibleBoxes = nodes
      .filter(node => !node.hidden && Number(node.style?.opacity ?? 1) > 0.1)
      .flatMap(node => {
        const rect = rects.get(node.id)
        return rect ? [{ id: node.id, rect }] : []
      })
    // Where lines meet boxes: a callout over a line's end hides which box
    // the path reached, so those spots weigh like another callout.
    const reach = 18 / safeZoom
    const taken: Box[] = lines.flatMap(line => [line.from, line.to]).map(point => ({
      x: point.x - reach, y: point.y - reach, width: reach * 2, height: reach * 2,
    }))
    const placed = callouts.flatMap(callout => {
      const at = visibility.visibleNodeId(callout.fileId)
      const rect = at ? bodyOf(at) : null
      if (!at || !rect) return []
      const onFile = at === callout.fileId
      const enclosing = new Set<string>()
      for (let id: string | undefined = at; id && !enclosing.has(id); id = byId.get(id)?.parentId) enclosing.add(id)
      const screen = calloutScreenSize(callout, !onFile)
      const size = { width: screen.width / safeZoom, height: screen.height / safeZoom }
      const obstacles = visibleBoxes.filter(box => !enclosing.has(box.id)).map(box => box.rect)
      const box = placeCallout(rect, size, obstacles, taken, CALLOUT_GAP / safeZoom)
      taken.push(box)
      return [{ ...callout, x: box.x, y: box.y, width: screen.width, onFile }]
    })

    return { lines, placed }
  }, [steps, callouts, nodes, visibilityOptions, safeZoom])

  if (!scene || (scene.lines.length === 0 && scene.placed.length === 0)) return null
  const inverse = 1 / safeZoom
  // A line into a function that has its own callout needs no label repeating it.
  const calloutSymbols = new Set(scene.placed.map(callout => callout.symbol))

  return (
    <ViewportPortal>
      <svg className="ambio-run-trace" width="1" height="1" aria-hidden="true">
        {scene.lines.map(line => (
          <g key={line.key} className={`ambio-run-trace__line${line.focus ? ' ambio-run-trace__line--focus' : ''}`}
            data-run-trace-source={line.source} data-run-trace-target={line.target}>
            <title>{line.pairs.join('\n')}</title>
            <path d={line.path} className="ambio-run-trace__casing" vectorEffect="non-scaling-stroke" />
            <path d={line.path} className="ambio-run-trace__stroke" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      {scene.lines.filter(line => line.label && !calloutSymbols.has(line.focusSymbol ?? '')).map(line => (
        <div key={`label-${line.key}`} className="ambio-run-trace__label"
          style={{ transform: `translate(${line.labelX}px, ${line.labelY}px) scale(${inverse}) translate(-50%, -50%)` }}>
          {line.label}
        </div>
      ))}
      {scene.placed.map(callout => (
        <div key={`callout-${callout.key}`}
          className={`ambio-run-callout ambio-run-callout--${callout.tone}`}
          data-run-callout={callout.symbol}
          style={{ width: callout.width, transform: `translate(${callout.x}px, ${callout.y}px) scale(${inverse})` }}>
          <div className="ambio-run-callout__head">
            <span className="ambio-run-callout__symbol">{callout.symbol || 'watched'}</span>
            {!callout.onFile && callout.fileName && (
              <span className="ambio-run-callout__file">{callout.fileName}</span>
            )}
            <span className="ambio-run-callout__count">
              {callout.errors > 0 ? `${callout.errors} of ${callout.calls} threw` : `${callout.calls} call${callout.calls === 1 ? '' : 's'}`}
            </span>
          </div>
          {callout.text && <div className="ambio-run-callout__text">{callout.text}</div>}
        </div>
      ))}
    </ViewportPortal>
  )
}
