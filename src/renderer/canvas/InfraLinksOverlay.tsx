import React from 'react'
import { getBezierPath, Position, ViewportPortal, useViewport, type Node } from '@xyflow/react'
import type { DbDependency, DbFile, DbSystem } from '../../shared/types'
import { absoluteRects, bodyRect, folderTabOf } from './folderAnchors.ts'
import { chooseLivingAnchorPair, type LivingAnchorSide, type LivingRect } from './livingEdgeGeometry.ts'
import { livingVisibilityIndex, type LivingVisibilityOptions } from './livingVisibility.ts'
import { infraLinks } from './infraLinks.ts'

interface InfraLinksOverlayProps {
  selectedId: string | null
  nodes: Node[]
  dependencies: readonly DbDependency[]
  infraIds: ReadonlySet<string>
  files: readonly DbFile[]
  systems: readonly DbSystem[]
  visibilityOptions: LivingVisibilityOptions
}

const positionBySide: Record<LivingAnchorSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

/**
 * What a selection depends on, drawn for as long as it is selected: an infra
 * node shows who touches it, a system or file shows what it touches. Curves
 * meet systems on their folder body, labels stay screen-sized, and nothing is
 * drawn once the selection moves on - the Floor keeps no permanent wiring.
 */
export function InfraLinksOverlay({
  selectedId, nodes, dependencies, infraIds, files, systems, visibilityOptions,
}: InfraLinksOverlayProps) {
  const { zoom } = useViewport()
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const fileSystem = React.useMemo(() => new Map(files.map(file => [file.id, file.systemId ?? null])), [files])
  const systemParent = React.useMemo(() => new Map(systems.map(system => [system.id, system.parentId ?? null])), [systems])

  const lines = React.useMemo(() => {
    if (!selectedId) return []
    const visibility = livingVisibilityIndex(nodes, visibilityOptions)
    const links = infraLinks({
      selectedId, dependencies, infraIds, fileSystem, systemParent,
      visibleNodeId: visibility.visibleNodeId,
    })
    if (links.length === 0) return []
    const rects = absoluteRects(nodes)
    const byId = new Map(nodes.map(node => [node.id, node]))
    const bodies = new Map<string, LivingRect>()
    const bodyOf = (id: string) => {
      const cached = bodies.get(id)
      if (cached) return cached
      const rect = rects.get(id)
      const node = byId.get(id)
      if (!rect || !node) return null
      const body = bodyRect(rect, folderTabOf(node))
      bodies.set(id, body)
      return body
    }
    const placed = links.flatMap(link => {
      const source = bodyOf(link.source)
      const target = bodyOf(link.target)
      if (!source || !target) return []
      return [{ link, source, target, anchors: chooseLivingAnchorPair(source, target) }]
    })
    // Lines that share a node's side are spread along it rather than meeting
    // at one point, so each stays distinguishable where it arrives.
    const spread = (end: 'source' | 'target') => {
      const groups = new Map<string, typeof placed>()
      for (const item of placed) {
        const side = end === 'source' ? item.anchors.sourceSide : item.anchors.targetSide
        const key = `${end === 'source' ? item.link.source : item.link.target}:${side}`
        groups.set(key, [...(groups.get(key) ?? []), item])
      }
      const points = new Map<(typeof placed)[number], { x: number; y: number }>()
      for (const group of groups.values()) {
        const other = (item: (typeof placed)[number]) => end === 'source' ? item.target : item.source
        const side = end === 'source' ? group[0].anchors.sourceSide : group[0].anchors.targetSide
        const rect = end === 'source' ? group[0].source : group[0].target
        const horizontal = side === 'top' || side === 'bottom'
        group.sort((a, b) => horizontal
          ? (other(a).x + other(a).width / 2) - (other(b).x + other(b).width / 2)
          : (other(a).y + other(a).height / 2) - (other(b).y + other(b).height / 2))
        group.forEach((item, index) => {
          const t = (index + 1) / (group.length + 1)
          const along = 0.2 + t * 0.6
          points.set(item, horizontal
            ? { x: rect.x + rect.width * along, y: side === 'top' ? rect.y : rect.y + rect.height }
            : { x: side === 'left' ? rect.x : rect.x + rect.width, y: rect.y + rect.height * along })
        })
      }
      return points
    }
    const from = spread('source')
    const to = spread('target')
    return placed.map(item => {
      const start = from.get(item)!
      const end = to.get(item)!
      const [path, labelX, labelY] = getBezierPath({
        sourceX: start.x,
        sourceY: start.y,
        sourcePosition: positionBySide[item.anchors.sourceSide],
        targetX: end.x,
        targetY: end.y,
        targetPosition: positionBySide[item.anchors.targetSide],
      })
      return { ...item.link, path, labelX, labelY }
    })
  }, [selectedId, nodes, dependencies, infraIds, fileSystem, systemParent, visibilityOptions])

  if (lines.length === 0) return null
  const inverse = 1 / safeZoom
  return (
    <ViewportPortal>
      <svg className="axiom-infra-links" width="1" height="1" aria-hidden="true">
        {lines.map(line => (
          <g key={line.key} className={`axiom-infra-links__line${line.generic ? ' axiom-infra-links__line--generic' : ''}`}
            data-infra-link-source={line.source} data-infra-link-target={line.target}>
            <path d={line.path} className="axiom-infra-links__casing" vectorEffect="non-scaling-stroke" />
            <path d={line.path} className="axiom-infra-links__stroke" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      {lines.map(line => (
        <div key={`label-${line.key}`} className="axiom-infra-links__label"
          data-infra-link-label={line.target}
          style={{ transform: `translate(${line.labelX}px, ${line.labelY}px) scale(${inverse}) translate(-50%, -50%)` }}>
          {line.label}
        </div>
      ))}
    </ViewportPortal>
  )
}
