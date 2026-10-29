import type { Edge, Node } from '@xyflow/react'
import { absoluteRects, bodyRect, folderTabOf, folderTopAnchorX, nodeSize } from '../folderAnchors.ts'
import type { LivingRect, LivingPoint, LivingAnchorSide } from '../livingEdgeGeometry.ts'

export interface SheetRelationshipRoute {
  points: LivingPoint[]
  path: string
  sourceSide: LivingAnchorSide
  targetSide: LivingAnchorSide
}
interface Port { side: LivingAnchorSide; point: LivingPoint; stub: LivingPoint }
interface Obstacle extends LivingRect { id: string }
const EPS = 1e-7
const distance = (a: LivingPoint, b: LivingPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

export function segmentCrossesRect(a: LivingPoint, b: LivingPoint, rect: LivingRect): boolean {
  if (Math.abs(a.x - b.x) < EPS) return a.x > rect.x + EPS && a.x < rect.x + rect.width - EPS &&
    Math.max(a.y, b.y) > rect.y + EPS && Math.min(a.y, b.y) < rect.y + rect.height - EPS
  return a.y > rect.y + EPS && a.y < rect.y + rect.height - EPS &&
    Math.max(a.x, b.x) > rect.x + EPS && Math.min(a.x, b.x) < rect.x + rect.width - EPS
}

function simplify(points: LivingPoint[]): LivingPoint[] {
  const result: LivingPoint[] = []
  for (const point of points) {
    if (result.length && distance(result.at(-1)!, point) < EPS) continue
    while (result.length > 1) {
      const a = result.at(-2)!, b = result.at(-1)!
      // Remove a collinear point only when it is between its neighbours.
      if (Math.abs(distance(a, b) + distance(b, point) - distance(a, point)) > EPS ||
        !(a.x === b.x && b.x === point.x || a.y === b.y && b.y === point.y)) break
      result.pop()
    }
    result.push(point)
  }
  return result
}

/** Route through free gutters, choosing endpoint faces as part of the route.
 * Ancestor containers are context; unrelated cards and frame tabs are obstacles. */
export function routeSheetRelationship(sourceId: string, targetId: string, nodes: readonly Node[]): SheetRelationshipRoute | null {
  const rects = absoluteRects(nodes)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const sourceRect = rects.get(sourceId), targetRect = rects.get(targetId)
  if (!sourceRect || !targetRect) return null
  const clearance = Math.max(0.01, Math.min(2, sourceRect.width / 25, sourceRect.height / 25, targetRect.width / 25, targetRect.height / 25))
  const ancestors = new Set<string>()
  for (const id of [sourceId, targetId]) {
    let parent = byId.get(id)?.parentId
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = byId.get(parent)?.parentId }
  }
  const obstacles: Obstacle[] = []
  for (const node of nodes) {
    if (ancestors.has(node.id) || node.hidden || node.style?.opacity === 0) continue
    const rect = rects.get(node.id)
    if (!rect) continue
    const tab = folderTabOf(node)
    const shapes = tab ? [bodyRect(rect, tab), { x: rect.x, y: rect.y, width: tab.exposedFrom, height: tab.height }] : [rect]
    for (const shape of shapes) obstacles.push({ id: node.id, x: shape.x - clearance, y: shape.y - clearance, width: shape.width + 2 * clearance, height: shape.height + 2 * clearance })
  }
  const ports = (id: string, rect: LivingRect): Port[] => {
    const tab = folderTabOf(byId.get(id)!)
    const body = bodyRect(rect, tab)
    return (['top', 'right', 'bottom', 'left'] as const).map(side => {
      const point = side === 'top' ? { x: rect.x + (tab ? folderTopAnchorX(tab, rect.width) : rect.width / 2), y: body.y }
        : side === 'bottom' ? { x: rect.x + rect.width / 2, y: rect.y + rect.height }
        : { x: side === 'left' ? rect.x : rect.x + rect.width, y: body.y + body.height / 2 }
      const stub = { x: point.x + (side === 'left' ? -clearance : side === 'right' ? clearance : 0), y: point.y + (side === 'top' ? -clearance : side === 'bottom' ? clearance : 0) }
      return { side, point, stub }
    }).filter(port => !obstacles.some(rect => rect.id !== id && segmentCrossesRect(port.point, port.stub, rect)))
  }
  const starts = ports(sourceId, sourceRect), ends = ports(targetId, targetRect)
  const clear = (a: LivingPoint, b: LivingPoint) => !obstacles.some(rect => segmentCrossesRect(a, b, rect))
  const finish = (start: Port, end: Port, middle: LivingPoint[]): SheetRelationshipRoute => {
    const points = simplify([start.point, ...middle, end.point])
    return { points, path: points.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(''), sourceSide: start.side, targetSide: end.side }
  }
  const lanes = (values: number[], middle: number) => {
    const sorted = [...new Set(values)].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))
    const low = values.reduce((min, value) => Math.min(min, value), Infinity)
    const high = values.reduce((max, value) => Math.max(max, value), -Infinity)
    return [...new Set([...sorted.slice(0, 32), low, high])]
  }
  const xs = lanes(obstacles.flatMap(rect => [rect.x, rect.x + rect.width]), (sourceRect.x + targetRect.x) / 2)
  const ys = lanes(obstacles.flatMap(rect => [rect.y, rect.y + rect.height]), (sourceRect.y + targetRect.y) / 2)
  let best: SheetRelationshipRoute | null = null, bestCost = Infinity
  for (const start of starts) for (const end of ends) {
    if (sourceId === targetId && start.side === end.side) continue
    if (distance(start.point, end.point) >= bestCost) continue
    const a = start.stub, b = end.stub
    const candidates = [
      [a, { x: a.x, y: b.y }, b], [a, { x: b.x, y: a.y }, b],
      ...xs.map(x => [a, { x, y: a.y }, { x, y: b.y }, b]),
      ...ys.map(y => [a, { x: a.x, y }, { x: b.x, y }, b]),
    ]
    for (const middle of candidates) {
      if (middle.some((point, i) => i > 0 && !clear(middle[i - 1], point))) continue
      const route = finish(start, end, middle)
      if (route.points.length < 2) continue
      const length = route.points.reduce((sum, point, i) => sum + (i ? distance(route.points[i - 1], point) : 0), 0)
      const cost = length + route.points.length * clearance * 2
      if (cost < bestCost) { best = route; bestCost = cost }
    }
  }
  if (best) return best
  // A visibility grid is the uncommon fallback for several staggered obstacles.
  // Bound the search; never fall back to drawing through a card.
  const gridX = [...new Set([...xs, ...starts.map(p => p.stub.x), ...ends.map(p => p.stub.x)])].sort((a, b) => a - b)
  const gridY = [...new Set([...ys, ...starts.map(p => p.stub.y), ...ends.map(p => p.stub.y)])].sort((a, b) => a - b)
  const cell = (p: LivingPoint) => gridY.indexOf(p.y) * gridX.length + gridX.indexOf(p.x)
  const point = (index: number): LivingPoint => ({ x: gridX[index % gridX.length], y: gridY[Math.floor(index / gridX.length)] })
  const queue: { cell: number; cost: number; origin: number }[] = []
  const push = (value: typeof queue[number]) => {
    queue.push(value)
    let index = queue.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (queue[parent].cost <= value.cost) break
      queue[index] = queue[parent]; index = parent
    }
    queue[index] = value
  }
  const pop = () => {
    const first = queue[0], last = queue.pop()!
    if (queue.length) {
      let index = 0
      while (index * 2 + 1 < queue.length) {
        let child = index * 2 + 1
        if (child + 1 < queue.length && queue[child + 1].cost < queue[child].cost) child++
        if (queue[child].cost >= last.cost) break
        queue[index] = queue[child]; index = child
      }
      queue[index] = last
    }
    return first
  }
  const costs = new Map<number, number>(), previous = new Map<number, number>()
  starts.forEach((start, origin) => { const key = cell(start.stub); push({ cell: key, cost: 0, origin }); costs.set(key, 0) })
  let steps = 0
  while (queue.length && steps++ < 10000) {
    const current = pop()
    if (costs.get(current.cell) !== current.cost) continue
    const start = starts[current.origin]
    const end = ends.find(end => cell(end.stub) === current.cell && !(sourceId === targetId && start.side === end.side))
    if (end) {
      const middle = [point(current.cell)]
      let cursor = current.cell
      while (previous.has(cursor)) { cursor = previous.get(cursor)!; middle.unshift(point(cursor)) }
      return finish(start, end, middle)
    }
    const x = current.cell % gridX.length, y = Math.floor(current.cell / gridX.length)
    const neighbours = [x > 0 ? current.cell - 1 : -1, x + 1 < gridX.length ? current.cell + 1 : -1,
      y > 0 ? current.cell - gridX.length : -1, y + 1 < gridY.length ? current.cell + gridX.length : -1]
    for (const next of neighbours) {
      if (next < 0 || !clear(point(current.cell), point(next))) continue
      const cost = current.cost + distance(point(current.cell), point(next))
      if (cost >= (costs.get(next) ?? Infinity)) continue
      costs.set(next, cost); previous.set(next, current.cell)
      push({ cell: next, cost, origin: current.origin })
    }
  }
  return null
}

/** Keep routes stable while zoom/selection changes presentation data only. */
export function createSheetRelationshipRouter() {
  let signature = ''
  const cache = new Map<string, SheetRelationshipRoute | null>()
  return (edges: Edge[], nodes: readonly Node[]) => {
    const nextSignature = nodes.map(node => {
      const size = nodeSize(node)
      return [node.id, node.parentId, node.type, node.position.x, node.position.y, size.width, size.height,
        node.hidden, node.style?.opacity === 0, node.data.depth, node.data.name, node.data.umlKind, node.data.presentationScale, node.data.directChildCount].join(':')
    }).join('|')
    if (signature !== nextSignature) { signature = nextSignature; cache.clear() }
    return edges.map(edge => {
      const key = `${edge.source}\0${edge.target}`
      if (!cache.has(key)) {
        if (cache.size >= 512) cache.clear()
        cache.set(key, routeSheetRelationship(edge.source, edge.target, nodes))
      }
      const route = cache.get(key)
      return { ...edge, sourceHandle: route ? `source-${route.sourceSide}` : edge.sourceHandle,
        targetHandle: route ? `target-${route.targetSide}` : edge.targetHandle,
        data: { ...edge.data, sheetRelationship: true, sheetRoute: route } }
    })
  }
}

export function sheetRelationshipInk(route: SheetRelationshipRoute, zoom: number) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const tip = route.points.at(-1)!, before = route.points.at(-2)!
  const length = Math.max(EPS, distance(tip, before))
  const dx = (tip.x - before.x) / length, dy = (tip.y - before.y) / length
  const back = { x: tip.x - dx * 8 / scale, y: tip.y - dy * 8 / scale }
  return { strokeWidth: 1.25 / scale, dash: `${5 / scale} ${4 / scale}`, interactionWidth: 10 / scale,
    arrow: `M${tip.x} ${tip.y}L${back.x - dy * 3.5 / scale} ${back.y + dx * 3.5 / scale}L${back.x + dy * 3.5 / scale} ${back.y - dx * 3.5 / scale}Z` }
}
