import React from 'react'
import { EdgeText, type EdgeProps, getSmoothStepPath, useStore } from '@xyflow/react'
import { ClippedDashedEdge } from './ClippedDashedEdge'
import { sheetRelationshipInk, type SheetRelationshipRoute } from './sheetRelationshipGeometry'

function SheetRelationship({ id, route, style, focused }: { id: string; route: SheetRelationshipRoute | null; style?: React.CSSProperties; focused?: boolean }) {
  // Subscribe only to zoom; panning leaves the route and its ink untouched.
  const zoom = useStore(state => state.transform[2])
  if (!route || route.points.length < 2) return null
  const ink = sheetRelationshipInk(route, zoom)
  const stroke = String(style?.stroke ?? 'var(--accent)')
  const first = route.points[0]
  return <>
    <ClippedDashedEdge id={id} path={route.path} interactionWidth={ink.interactionWidth} cornerRadius={Math.min(5 / zoom, route.cornerRadius ?? 5 / zoom)} terminalReserve={ink.arrowLength} haloWidth={focused ? 5 / zoom : 0}
      style={{ ...style, vectorEffect: undefined, stroke, strokeWidth: focused ? 2 / zoom : ink.strokeWidth, strokeDasharray: focused ? undefined : ink.dash, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
    <circle className="ambio-sheet-relationship-source" cx={first.x} cy={first.y} r={2 / zoom} fill="var(--bg-surface)" stroke={stroke} strokeWidth={ink.strokeWidth} style={{ opacity: style?.opacity }} pointerEvents="none" />
    <path className="ambio-sheet-relationship-arrow" d={ink.arrow} fill={stroke} style={{ opacity: style?.opacity }} pointerEvents="none" />
  </>
}

/**
 * Hard-corner stepped edge that respects the actual source and target faces.
 * Static diagram edges and transient living flows share the path primitive,
 * while living flows add their one-shot travelling pulse.
 */
export function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps) {
  if (data?.sheetRelationship) return <SheetRelationship id={id} route={data.sheetRoute as SheetRelationshipRoute | null} style={style} focused={Boolean(data.relationshipFocused)} />
  const [pathD, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 0,
    offset: 18,
  })

  const isTraced = !!(data as any)?.isTraced
  const isSliced = !!(data as any)?.sliced
  const isLiving = !!(data as any)?.living
  const livingColor = String((data as any)?.color ?? style?.stroke ?? '#8b6fb3')
  const livingDelayMs = Number((data as any)?.delayMs ?? 0)
  const livingTravelMs = Number((data as any)?.travelMs ?? 1550)
  const stroke = isLiving
    ? livingColor
    : isSliced
      ? '#a855f7'
      : isTraced
        ? 'var(--trace-color)'
        // A static edge may carry its own colour (a sheet's proposed relationship).
        : String(style?.stroke ?? 'var(--border)')

  return (
    <>
      {!isLiving && !isTraced && !isSliced && style?.strokeDasharray ? <ClippedDashedEdge
        id={id} path={pathD} markerEnd={markerEnd}
        style={{ ...style, stroke, transition: 'stroke 0.2s ease, stroke-width 0.2s ease' }} /> : <>
      <path
        id={id}
        d={pathD}
        pathLength={isLiving ? 1 : undefined}
        className="react-flow__edge-path"
        fill="none"
        markerEnd={markerEnd}
        strokeWidth={isLiving ? 2.5 : isTraced || isSliced ? 2 : 1}
        strokeDasharray={isLiving ? '0.13 0.87' : isTraced ? '8 4' : undefined}
        style={{
          ...style,
          stroke,
          animation: isLiving
            ? `ambioLivingFlowTravel ${livingTravelMs}ms cubic-bezier(0.22, 1, 0.36, 1) both`
            : isTraced ? 'traceFlow 0.6s linear infinite' : undefined,
          animationDelay: isLiving ? `${livingDelayMs}ms` : undefined,
          filter: isLiving
            ? `drop-shadow(0 0 5px ${livingColor})`
            : isTraced ? 'drop-shadow(0 0 4px var(--trace-color))' : undefined,
          transition: 'stroke 0.2s ease, stroke-width 0.2s ease',
        }}
      />
      <path
        d={pathD}
        className="react-flow__edge-interaction"
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        style={{ cursor: 'pointer' }}
      />
      </>}
      {label != null && (
        <EdgeText
          x={labelX}
          y={labelY}
          label={label}
          labelStyle={labelStyle}
          labelShowBg={labelShowBg}
          labelBgStyle={labelBgStyle}
          labelBgPadding={labelBgPadding}
          labelBgBorderRadius={labelBgBorderRadius}
        />
      )}
    </>
  )
}
