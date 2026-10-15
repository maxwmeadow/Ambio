import React from 'react'
import {
  getSmoothStepPath,
  Position,
  ViewportPortal,
  useStore,
  type Node,
} from '@xyflow/react'

import type { LivingRelationshipFx } from '../store/graphStore.ts'
import {
  livingFlowEndpoints,
  relationshipVisual,
} from './livingChoreography.ts'
import {
  indexedLivingNodeRect,
  chooseClosestLivingBoundaryAnchors,
  livingPulseGeometry,
  type LivingAnchorSide,
} from './livingEdgeGeometry.ts'
import {
  livingVisibilityIndex,
  type LivingVisibilityOptions,
} from './livingVisibility.ts'
import {
  nextLivingPaintAttempt,
  recordLivingFlowDiagnostic,
} from './livingDiagnostics.ts'

interface LivingFlowOverlayProps {
  events: LivingRelationshipFx[]
  nodes: Node[]
  visibilityOptions: LivingVisibilityOptions
}

const positionBySide: Record<LivingAnchorSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

/**
 * Living relationships occupy their own final canvas plane. ViewportPortal
 * keeps world coordinates synchronized with pan and zoom while bypassing
 * React Flow's edge/node z-order and transient hidden-node measurements.
 */
export function LivingFlowOverlay({
  events,
  ...props
}: LivingFlowOverlayProps) {
  if (events.length === 0) return null
  return <ActiveLivingFlowOverlay events={events} {...props} />
}

function ActiveLivingFlowOverlay({
  events,
  nodes,
  visibilityOptions,
}: LivingFlowOverlayProps) {
  const zoom = useStore(state => state.transform[2])
  const routes = React.useMemo(() => {
    const visibility = livingVisibilityIndex(nodes, visibilityOptions)
    const byId = new Map(nodes.map(node => [node.id, node]))
    return events.flatMap(event => {
      const causal = livingFlowEndpoints(event)
      // Hidden endpoints still have authored geometry and must remain the real
      // flow destinations. Fall back to a visible ancestor only when a sheet
      // projection genuinely omitted the endpoint.
      const sourceId = byId.has(causal.source)
        ? causal.source
        : visibility.visibleNodeId(causal.source)
      const targetId = byId.has(causal.target)
        ? causal.target
        : visibility.visibleNodeId(causal.target)
      if (!sourceId || !targetId || sourceId === targetId) return []

      const sourceRect = indexedLivingNodeRect(sourceId, byId)
      const targetRect = indexedLivingNodeRect(targetId, byId)
      if (!sourceRect || !targetRect) return []

      const anchors = chooseClosestLivingBoundaryAnchors(sourceRect, targetRect)
      const source = anchors.source
      const target = anchors.target
      const [path] = getSmoothStepPath({
        sourceX: source.x,
        sourceY: source.y,
        sourcePosition: positionBySide[anchors.sourceSide],
        targetX: target.x,
        targetY: target.y,
        targetPosition: positionBySide[anchors.targetSide],
        borderRadius: 14,
        offset: 18,
      })

      return [{
        event,
        path,
        source,
        target,
        color: relationshipVisual(event).color,
        sourceId,
        targetId,
      }]
    })
  }, [events, nodes, visibilityOptions])
  // Camera zoom changes pulse size, not the world-space route or its ancestry.
  const flows = React.useMemo(() => routes.map(route => ({
    ...route,
    pulse: livingPulseGeometry(route.source, route.target, zoom),
  })), [routes, zoom])

  if (flows.length === 0) return null

  return (
    <ViewportPortal>
      <svg
        className="ambio-living-flow-overlay"
        width="1"
        height="1"
        aria-hidden="true"
      >
        {flows.map(flow => (
            <g
              key={flow.event.key}
              className={`ambio-living-flow ambio-living-flow--${flow.event.change}`}
              data-living-flow-key={flow.event.key}
              data-living-flow-trace={flow.event.traceId ?? 'legacy'}
              data-living-flow-source={flow.sourceId}
              data-living-flow-target={flow.targetId}
              style={{
                '--living-flow-color': flow.color,
                '--living-flow-delay': `${flow.event.delayMs}ms`,
                '--living-flow-travel': `${flow.event.travelMs}ms`,
                '--living-flow-head': flow.pulse.headFraction,
                '--living-flow-tail': flow.pulse.tailFraction,
                '--living-flow-dash-start': flow.pulse.dashStart,
                '--living-flow-dash-end': flow.pulse.dashEnd,
              } as React.CSSProperties}
            >
              {/* The whole route, faintly, for as long as the pulse travels
                  it: a lone dash crossing empty canvas never said where it
                  came from or where it was going. */}
              <path
                d={flow.path}
                className="ambio-living-flow__track"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={flow.path}
                className="ambio-living-flow__pulse"
                pathLength={1}
                vectorEffect="non-scaling-stroke"
                onAnimationStart={animationEvent => {
                  if (animationEvent.target !== animationEvent.currentTarget) return
                  recordLivingFlowDiagnostic('paint-start', {
                    traceId: flow.event.traceId ?? 'legacy',
                    key: flow.event.key,
                    route: `${flow.sourceId}->${flow.targetId}`,
                    semanticRoute: `${flow.event.src}->${flow.event.dst}`,
                    relationship: flow.event.relationship,
                    change: flow.event.change,
                    eventCount: flow.event.eventCount,
                    paintAttempt: nextLivingPaintAttempt(flow.event.key),
                    screenLength: Number(flow.pulse.screenLength.toFixed(1)),
                    delayMs: flow.event.delayMs,
                    travelMs: flow.event.travelMs,
                    reason: animationEvent.animationName,
                  })
                }}
                onAnimationEnd={animationEvent => {
                  if (animationEvent.target !== animationEvent.currentTarget) return
                  recordLivingFlowDiagnostic('paint-end', {
                    traceId: flow.event.traceId ?? 'legacy',
                    key: flow.event.key,
                    route: `${flow.sourceId}->${flow.targetId}`,
                    semanticRoute: `${flow.event.src}->${flow.event.dst}`,
                    relationship: flow.event.relationship,
                    change: flow.event.change,
                    eventCount: flow.event.eventCount,
                    screenLength: Number(flow.pulse.screenLength.toFixed(1)),
                    travelMs: flow.event.travelMs,
                    reason: animationEvent.animationName,
                  })
                }}
              />
            </g>
        ))}
      </svg>
    </ViewportPortal>
  )
}
