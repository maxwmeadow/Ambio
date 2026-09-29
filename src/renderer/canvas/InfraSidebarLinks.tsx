import React from 'react'
import { useReactFlow, useViewport, type Node } from '@xyflow/react'
import type { DbDependency, DbFile, DbSystem } from '../../shared/types'
import { absoluteRects, bodyRect, folderTabOf } from './folderAnchors.ts'
import type { LivingRect } from './livingEdgeGeometry.ts'
import { livingVisibilityIndex, type LivingVisibilityOptions } from './livingVisibility.ts'
import { infraLinks, type InfraLink } from './infraLinks.ts'
import { useGraphStore } from '../store/graphStore'

interface InfraSidebarLinksProps {
  nodes: Node[]
  dependencies: readonly DbDependency[]
  files: readonly DbFile[]
  systems: readonly DbSystem[]
  selectedNodeId: string | null
  visibilityOptions: LivingVisibilityOptions
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface Placed {
  link: InfraLink
  path: string
  /** Where the line leaves its sidebar row. */
  start: { x: number; y: number }
  /** Screen box of the node the line meets, when it is in view. */
  target: { x: number; y: number; width: number; height: number } | null
  /** Where an off-screen target is announced, on the edge of the view. */
  marker: { x: number; y: number; side: 'right' | 'top' | 'bottom'; name: string; world: { x: number; y: number } } | null
}

const EDGE_INSET = 14

const MARKER_ANCHOR = {
  right: 'translate(-100%, -50%)',
  top: 'translate(-50%, 0)',
  bottom: 'translate(-50%, -100%)',
} as const

/**
 * Lines between the infrastructure sidebar and the canvas (INFRA_LAYER_PLAN.md,
 * "Canvas placement"). Drawn in screen space because one end is a sidebar row
 * and the other a box on the map. A box outside the view is announced on the
 * view's edge instead, and clicking the marker brings it into view. Nothing is
 * drawn once the selection moves on.
 */
export function InfraSidebarLinks({
  nodes, dependencies, files, systems, selectedNodeId, visibilityOptions, containerRef,
}: InfraSidebarLinksProps) {
  const open = useGraphStore(s => s.infraSidebarOpen)
  const selectedInfraId = useGraphStore(s => s.selectedInfraId)
  const infraNodes = useGraphStore(s => s.infraNodes)
  const { x: vx, y: vy, zoom } = useViewport()
  const { setCenter, getZoom } = useReactFlow()
  const [frame, setFrame] = React.useState(0)

  const fileSystem = React.useMemo(() => new Map(files.map(file => [file.id, file.systemId ?? null])), [files])
  const systemParent = React.useMemo(() => new Map(systems.map(system => [system.id, system.parentId ?? null])), [systems])
  const nameOf = React.useMemo(() => {
    const names = new Map<string, string>()
    for (const system of systems) names.set(system.id, system.name)
    for (const file of files) names.set(file.id, file.relPath.split('/').pop() ?? file.relPath)
    return names
  }, [files, systems])
  const listedIds = React.useMemo(
    () => new Set(infraNodes.filter(node => node.status !== 'dismissed').map(node => node.id)),
    [infraNodes],
  )

  const links = React.useMemo(() => {
    if (!open) return []
    const visibility = livingVisibilityIndex(nodes, visibilityOptions)
    return infraLinks({
      selectedInfraId,
      selectedNodeId: selectedInfraId ? null : selectedNodeId,
      dependencies, infraIds: listedIds, fileSystem, systemParent,
      visibleNodeId: visibility.visibleNodeId,
    })
  }, [open, selectedInfraId, selectedNodeId, nodes, visibilityOptions, dependencies, listedIds, fileSystem, systemParent])

  // World-space boxes, recomputed only when the scene changes, not per frame.
  const worldRects = React.useMemo(() => {
    if (links.length === 0) return new Map<string, LivingRect>()
    const rects = absoluteRects(nodes)
    const byId = new Map(nodes.map(node => [node.id, node]))
    const out = new Map<string, LivingRect>()
    for (const link of links) {
      const rect = rects.get(link.nodeId)
      const node = byId.get(link.nodeId)
      if (rect && node) out.set(link.nodeId, bodyRect(rect, folderTabOf(node)))
    }
    return out
  }, [links, nodes])

  // The sidebar scrolls and resizes on its own; follow it.
  React.useEffect(() => {
    if (links.length === 0) return
    const container = containerRef.current
    const list = container?.querySelector('.axiom-infra-sidebar__list')
    const bump = () => setFrame(value => value + 1)
    list?.addEventListener('scroll', bump, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' || !container ? null : new ResizeObserver(bump)
    if (container) observer?.observe(container)
    return () => {
      list?.removeEventListener('scroll', bump)
      observer?.disconnect()
    }
  }, [links.length, containerRef])

  const [placed, setPlaced] = React.useState<{ items: Placed[]; width: number; height: number }>({ items: [], width: 0, height: 0 })
  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || links.length === 0) {
      setPlaced(current => current.items.length === 0 ? current : { items: [], width: 0, height: 0 })
      return
    }
    const box = container.getBoundingClientRect()
    const sidebar = container.querySelector('.axiom-infra-sidebar')?.getBoundingClientRect()
    const list = container.querySelector('.axiom-infra-sidebar__list')?.getBoundingClientRect()
    if (!sidebar || !list) {
      setPlaced({ items: [], width: 0, height: 0 })
      return
    }
    const region = {
      left: sidebar.right - box.left + EDGE_INSET,
      top: EDGE_INSET,
      right: box.width - EDGE_INSET,
      bottom: box.height - EDGE_INSET,
    }
    const rowPoint = (infraId: string) => {
      const row = container.querySelector(`[data-infra-row="${CSS.escape(infraId)}"]`)?.getBoundingClientRect()
      if (!row) return null
      // A row scrolled out of the list pins to the list's edge.
      const y = Math.min(list.bottom - 6, Math.max(list.top + 6, row.top + row.height / 2)) - box.top
      return { x: sidebar.right - box.left, y }
    }

    const targets = new Map<string, { x: number; y: number; width: number; height: number; inView: boolean }>()
    for (const [id, rect] of worldRects) {
      const screen = { x: rect.x * zoom + vx, y: rect.y * zoom + vy, width: rect.width * zoom, height: rect.height * zoom }
      const inView = screen.x + screen.width > region.left + 8 && screen.x < region.right - 8
        && screen.y + screen.height > region.top + 8 && screen.y < region.bottom - 8
      targets.set(id, { ...screen, inView })
    }

    // Lines arriving at the same box spread along its facing side.
    const arrivals = new Map<string, InfraLink[]>()
    for (const link of links) arrivals.set(link.nodeId, [...(arrivals.get(link.nodeId) ?? []), link])

    const items: Placed[] = []
    for (const link of links) {
      const start = rowPoint(link.infraId)
      const target = targets.get(link.nodeId)
      if (!start || !target) continue
      let end: { x: number; y: number }
      let marker: Placed['marker'] = null
      if (target.inView) {
        const siblings = arrivals.get(link.nodeId)!
        const index = siblings.indexOf(link)
        const along = siblings.length === 1 ? 0.5 : 0.2 + (index / (siblings.length - 1)) * 0.6
        const visibleTop = Math.max(target.y, region.top)
        const visibleBottom = Math.min(target.y + target.height, region.bottom)
        end = { x: Math.max(target.x, region.left), y: visibleTop + (visibleBottom - visibleTop) * along }
      } else {
        // Toward the box's centre, stopped at the edge of the view.
        const cx = target.x + target.width / 2
        const cy = target.y + target.height / 2
        const dx = cx - start.x
        const dy = cy - start.y
        let t = 1
        if (dx > 0) t = Math.min(t, (region.right - start.x) / dx)
        if (dy > 0) t = Math.min(t, (region.bottom - start.y) / dy)
        if (dy < 0) t = Math.min(t, (region.top - start.y) / dy)
        t = Math.max(0.2, t)
        end = {
          x: Math.min(region.right, Math.max(region.left + 40, start.x + dx * t)),
          y: Math.min(region.bottom, Math.max(region.top, start.y + dy * t)),
        }
        const worldRect = worldRects.get(link.nodeId)!
        marker = {
          x: end.x, y: end.y,
          side: end.x >= region.right - 1 ? 'right' : end.y <= region.top + 1 ? 'top' : end.y >= region.bottom - 1 ? 'bottom' : 'right',
          name: nameOf.get(link.nodeId) ?? 'Off screen',
          world: { x: worldRect.x + worldRect.width / 2, y: worldRect.y + worldRect.height / 2 },
        }
      }
      const bend = Math.max(48, (end.x - start.x) * 0.45)
      const c1 = { x: start.x + bend, y: start.y }
      const c2 = { x: end.x - bend, y: end.y }
      items.push({
        link,
        path: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
        start,
        target: target.inView ? { x: target.x, y: target.y, width: target.width, height: target.height } : null,
        marker,
      })
    }
    setPlaced({ items, width: box.width, height: box.height })
  }, [links, worldRects, vx, vy, zoom, frame, containerRef, nameOf])

  if (placed.items.length === 0) return null
  const rowSelected = selectedInfraId !== null
  const outlined = new Map<string, NonNullable<Placed['target']>>()
  for (const item of placed.items) if (item.target) outlined.set(item.link.nodeId, item.target)
  return (
    <div className="axiom-infra-links" aria-hidden={false}>
      <svg className="axiom-infra-links__svg" width={placed.width} height={placed.height} aria-hidden="true">
        {[...outlined.entries()].map(([id, rect]) => (
          <rect key={`outline-${id}`} className="axiom-infra-links__outline"
            x={rect.x - 3} y={rect.y - 3} width={rect.width + 6} height={rect.height + 6} rx={4} />
        ))}
        {placed.items.map(item => (
          <g key={item.link.key}
            className={`axiom-infra-links__line${item.link.generic ? ' axiom-infra-links__line--generic' : ''}${item.marker ? ' axiom-infra-links__line--away' : ''}`}
            data-infra-link-source={item.link.infraId} data-infra-link-target={item.link.nodeId}>
            <path d={item.path} className="axiom-infra-links__casing" />
            <path d={item.path} className="axiom-infra-links__stroke" />
          </g>
        ))}
      </svg>
      {/* Labels sit where they cannot pile up. A sidebar row fans out to many
          boxes, so each label rides on its box; a selected box fans out to
          many rows, so each label sits beside its row. */}
      {rowSelected
        ? placed.items.filter(item => item.target).map(item => {
          // A box too narrow for its label shows the file count; the full
          // wording is on hover and returns when you zoom in.
          const fits = item.link.label.length * 6.7 + 18 <= item.target!.width - 8
          return (
            <div key={`label-${item.link.key}`}
              className={`axiom-infra-links__label${fits ? '' : ' axiom-infra-links__label--compact'}`}
              data-infra-link-label={item.link.nodeId}
              title={fits ? undefined : item.link.label}
              style={{ transform: `translate(${item.target!.x + 4}px, ${item.target!.y + item.target!.height - 4}px) translateY(-100%)` }}>
              {fits ? item.link.label : item.link.files}
            </div>
          )
        })
        : placed.items.map(item => (
          <div key={`label-${item.link.key}`} className="axiom-infra-links__label axiom-infra-links__label--row"
            data-infra-link-label={item.link.infraId}
            style={{ transform: `translate(${item.start.x + 8}px, ${item.start.y}px) translateY(-50%)` }}>
            {item.link.label}
          </div>
        ))}
      {rowSelected && placed.items.filter(item => item.marker).map(item => (
        <button key={`marker-${item.link.key}`} type="button" className="axiom-infra-links__marker"
          data-infra-link-marker={item.link.nodeId}
          data-side={item.marker!.side}
          style={{ transform: `translate(${item.marker!.x}px, ${item.marker!.y}px) ${MARKER_ANCHOR[item.marker!.side]}` }}
          title={`${item.marker!.name}: ${item.link.label}. Click to bring it into view.`}
          onClick={() => void setCenter(item.marker!.world.x, item.marker!.world.y, { zoom: Math.max(getZoom(), 0.35), duration: 500 })}>
          <span>{item.marker!.name}</span>
          <small>{item.link.label}</small>
          <span aria-hidden="true">{item.marker!.side === 'top' ? '↑' : item.marker!.side === 'bottom' ? '↓' : '→'}</span>
        </button>
      ))}
    </div>
  )
}
