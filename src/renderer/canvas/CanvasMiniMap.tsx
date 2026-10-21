import React, { useId, useMemo } from 'react'
import { Panel, useStore, useStoreApi } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { minimapScene, minimapView, type MinimapRect } from './minimapGeometry'

const Marks = React.memo(function Marks({ rects }: { rects: MinimapRect[] }) {
  return <>{rects.map(rect => <rect key={rect.id}
    className={`react-flow__minimap-node${rect.selected ? ' selected' : ''}`}
    x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={5} ry={5}
    style={{ fill: rect.color }} shapeRendering="crispEdges" />)}</>
})

/** The canvas's passive minimap, with one store subscription for the surface.
 * The upstream MiniMap creates a subscribed component even for every hidden
 * node. Keep its exact geometry/style while materializing only visible marks. */
export function CanvasMiniMap() {
  const store = useStoreApi()
  const { nodes, transform, width, height, label } = useStore(useShallow(state => ({
    nodes: state.nodes, transform: state.transform, width: state.width, height: state.height,
    label: state.ariaLabelConfig['minimap.ariaLabel'],
  })))
  const scene = useMemo(() => minimapScene(nodes, id => {
    const node = store.getState().nodeLookup.get(id)
    if (!node) return
    return { ...node.internals.positionAbsolute,
      width: node.measured.width ?? node.width ?? node.initialWidth ?? 0,
      height: node.measured.height ?? node.height ?? node.initialHeight ?? 0 }
  }), [nodes, store])
  const z = Math.max(.0001, transform[2])
  const viewport = { x: -transform[0] / z, y: -transform[1] / z, width: width / z, height: height / z }
  const view = minimapView(scene.bounds, viewport)
  const labelledBy = useId()
  return <Panel position="top-right" className="react-flow__minimap ambio-canvas-minimap"
    style={{ width: 160, height: 100 }}>
    <svg width={160} height={100} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      className="react-flow__minimap-svg" role="img" aria-labelledby={label ? labelledBy : undefined}>
      {label && <title id={labelledBy}>{label}</title>}
      <Marks rects={scene.rects} />
      <path className="react-flow__minimap-mask" fillRule="evenodd" pointerEvents="none"
        style={{ fill: 'rgba(49,62,58,0.38)' }}
        d={`M${view.x - view.offset},${view.y - view.offset}h${view.width + view.offset * 2}v${view.height + view.offset * 2}h${-view.width - view.offset * 2}z M${viewport.x},${viewport.y}h${viewport.width}v${viewport.height}h${-viewport.width}z`} />
    </svg>
  </Panel>
}
