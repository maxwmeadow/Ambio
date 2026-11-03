import type { Edge, Node } from '@xyflow/react'
import { absoluteRects, bodyRect, folderTabOf, nodeSize } from '../folderAnchors.ts'
import type { LivingRect, LivingPoint, LivingAnchorSide } from '../livingEdgeGeometry.ts'

export interface SheetRelationshipRoute {
  points: LivingPoint[]
  path: string
  sourceSide: LivingAnchorSide
  targetSide: LivingAnchorSide
  cornerRadius?: number
}
interface RouteOptions { sourceFraction?: number; targetFraction?: number; reserved?: readonly SheetRelationshipRoute[] }
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
export function routeSheetRelationship(sourceId: string, targetId: string, nodes: readonly Node[], options: RouteOptions = {}): SheetRelationshipRoute | null {
  const rects = absoluteRects(nodes)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const sourceRect = rects.get(sourceId), targetRect = rects.get(targetId)
  if (!sourceRect || !targetRect) return null
  const clearance = Math.max(0.01, Math.min(2, sourceRect.width / 25, sourceRect.height / 25, targetRect.width / 25, targetRect.height / 25))
  const lead = Math.max(clearance, Math.min(8, sourceRect.height * .08, targetRect.height * .08))
  const separation = Math.max(clearance * 2, lead * 2)
  const reserved = (options.reserved ?? []).slice(-32)
  const ancestors = new Set<string>()
  for (const id of [sourceId, targetId]) {
    let parent = byId.get(id)?.parentId
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = byId.get(parent)?.parentId }
  }
  const obstacles: Obstacle[] = []
  for (const node of nodes) {
    const rect = rects.get(node.id)
    if (!rect) continue
    const tab = folderTabOf(node)
    const title = tab ? { x: rect.x, y: rect.y, width: tab.exposedFrom, height: bodyRect(rect, tab).y - rect.y } : null
    // Very small/collapsed frames can overlap a forcibly revealed descendant.
    // Such chrome cannot be used to enclose the endpoint in an obstacle.
    const enclosesEndpoint = title && [sourceRect, targetRect].some(endpoint => title.x < endpoint.x + endpoint.width && endpoint.x < title.x + title.width && title.y < endpoint.y + endpoint.height && endpoint.y < title.y + title.height)
    const shapes = ancestors.has(node.id) ? (title && !enclosesEndpoint ? [title] : []) : title ? [bodyRect(rect, tab), title] : [rect]
    for (const shape of shapes) obstacles.push({ id: node.id, x: shape.x - clearance, y: shape.y - clearance, width: shape.width + 2 * clearance, height: shape.height + 2 * clearance })
  }
  const ports = (id: string, rect: LivingRect, fraction = .5): Port[] => {
    const tab = folderTabOf(byId.get(id)!)
    const body = bodyRect(rect, tab)
    return (['top', 'right', 'bottom', 'left'] as const).map(side => {
      const point = side === 'top' ? { x: rect.x + (tab ? tab.exposedFrom + (rect.width - tab.exposedFrom) * fraction : rect.width * fraction), y: body.y }
        : side === 'bottom' ? { x: rect.x + rect.width * fraction, y: rect.y + rect.height }
        : { x: side === 'left' ? rect.x : rect.x + rect.width, y: body.y + body.height * fraction }
      const stub = { x: point.x + (side === 'left' ? -lead : side === 'right' ? lead : 0), y: point.y + (side === 'top' ? -lead : side === 'bottom' ? lead : 0) }
      return { side, point, stub }
    }).filter(port => !obstacles.some(rect => rect.id !== id && segmentCrossesRect(port.point, port.stub, rect)))
  }
  const starts = ports(sourceId, sourceRect, options.sourceFraction), ends = ports(targetId, targetRect, options.targetFraction)
  const clear = (a: LivingPoint, b: LivingPoint) => !obstacles.some(rect => segmentCrossesRect(a, b, rect))
  const finish = (start: Port, end: Port, middle: LivingPoint[]): SheetRelationshipRoute | null => {
    const points = simplify([start.point, ...middle, end.point])
    // A terminal must approach its face normally, and no corner may double
    // back on itself. Tiny reverse stubs make arrowheads appear to bend.
    const normal = (side: LivingAnchorSide, a: LivingPoint, b: LivingPoint) => side === 'left' ? b.x < a.x && b.y === a.y : side === 'right' ? b.x > a.x && b.y === a.y : side === 'top' ? b.y < a.y && b.x === a.x : b.y > a.y && b.x === a.x
    if (points.length < 2 || !normal(start.side, points[0], points[1]) || !normal(end.side, points.at(-1)!, points.at(-2)!)) return null
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1]
      if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < -EPS) return null
    }
    return { points, path: points.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(''), sourceSide: start.side, targetSide: end.side, cornerRadius: clearance }
  }
  const lanes = (values: number[], middle: number) => {
    const sorted = [...new Set(values)].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))
    const low = values.reduce((min, value) => Math.min(min, value), Infinity)
    const high = values.reduce((max, value) => Math.max(max, value), -Infinity)
    return [...new Set([...sorted.slice(0, 32), low, high])]
  }
  const xs = lanes([...obstacles.flatMap(rect => [rect.x, rect.x + rect.width]), ...reserved.flatMap(route => route.points.flatMap(p => [p.x - separation, p.x + separation]))], (sourceRect.x + targetRect.x) / 2)
  const ys = lanes([...obstacles.flatMap(rect => [rect.y, rect.y + rect.height]), ...reserved.flatMap(route => route.points.flatMap(p => [p.y - separation, p.y + separation]))], (sourceRect.y + targetRect.y) / 2)
  const congestion = (points: LivingPoint[]) => {
    let cost = 0
    for (let i = 1; i < points.length; i++) for (const route of reserved) for (let j = 1; j < route.points.length; j++) {
      const a = points[i - 1], b = points[i], c = route.points[j - 1], d = route.points[j]
      const vertical = a.x === b.x, otherVertical = c.x === d.x
      if (vertical === otherVertical) {
        const apart = Math.abs(vertical ? a.x - c.x : a.y - c.y)
        const overlap = Math.min(Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x), Math.max(vertical ? c.y : c.x, vertical ? d.y : d.x)) - Math.max(Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x), Math.min(vertical ? c.y : c.x, vertical ? d.y : d.x))
        if (apart < separation && overlap > 0) cost += overlap * 10 * (1 - apart / separation)
      } else {
        const v = vertical ? [a, b] : [c, d], h = vertical ? [c, d] : [a, b]
        if (v[0].x > Math.min(h[0].x, h[1].x) + EPS && v[0].x < Math.max(h[0].x, h[1].x) - EPS && h[0].y > Math.min(v[0].y, v[1].y) + EPS && h[0].y < Math.max(v[0].y, v[1].y) - EPS) cost += lead * 6
      }
    }
    return cost
  }
  let best: SheetRelationshipRoute | null = null, bestCost = Infinity
  for (const start of starts) for (const end of ends) {
    if (sourceId === targetId && start.side === end.side) continue
    if (distance(start.point, end.point) >= bestCost) continue
    const a = start.stub, b = end.stub
    const direct = (start.point.x === end.point.x || start.point.y === end.point.y) && !obstacles.some(rect => rect.id !== sourceId && rect.id !== targetId && segmentCrossesRect(start.point, end.point, rect)) ? [[]] : []
    const candidates = [...direct,
      [a, { x: a.x, y: b.y }, b], [a, { x: b.x, y: a.y }, b],
      ...xs.map(x => [a, { x, y: a.y }, { x, y: b.y }, b]),
      ...ys.map(y => [a, { x: a.x, y }, { x: b.x, y }, b]),
    ]
    for (const middle of candidates) {
      if (middle.some((point, i) => i > 0 && !clear(middle[i - 1], point))) continue
      const route = finish(start, end, middle)
      if (!route) continue
      const length = route.points.reduce((sum, point, i) => sum + (i ? distance(route.points[i - 1], point) : 0), 0)
      const cost = length + (route.points.length - 2) * lead * 3 + congestion(route.points)
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
      const route = finish(start, end, middle)
      if (route) return route
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

/** Separate incident ports and retain routed gutters across camera/selection
 * changes. The complete topology supplies stable slots; only requested edges
 * are solved. Cached routes reserve their lanes for subsequent connections. */
export function createSheetRelationshipRouter() {
  let signature = ''
  const cache = new Map<string, SheetRelationshipRoute | null>()
  let slots = new Map<string, number>()
  return (edges: Edge[], nodes: readonly Node[], topology: Edge[] = edges) => {
    const geometry = nodes.map(node => {
      const size = nodeSize(node)
      return [node.id, node.parentId, node.type, node.position.x, node.position.y, size.width, size.height,
        node.data.depth, node.data.name, node.data.umlKind, node.data.presentationScale, node.data.directChildCount].join(':')
    }).join('|')
    const topologyKey = topology.map(edge => `${edge.id}:${edge.source}:${edge.target}`).sort().join('|')
    const nextSignature = `${geometry}#${topologyKey}`
    if (signature !== nextSignature) {
      signature = nextSignature; cache.clear(); slots = new Map()
      const rects = absoluteRects(nodes)
      const incidents = new Map<string, Array<{ key: string; other: string }>>()
      for (const edge of topology) for (const [id, other, end] of [[edge.source, edge.target, 'source'], [edge.target, edge.source, 'target']]) {
        const list = incidents.get(id) ?? []; list.push({ key: `${edge.id}:${end}`, other }); incidents.set(id, list)
      }
      for (const list of incidents.values()) {
        list.sort((a, b) => {
          const ar = rects.get(a.other), br = rects.get(b.other)
          return (ar?.y ?? 0) - (br?.y ?? 0) || (ar?.x ?? 0) - (br?.x ?? 0) || a.key.localeCompare(b.key)
        })
        list.forEach((item, index) => slots.set(item.key, (index + 1) / (list.length + 1)))
      }
    }
    const routed = new Map<string, SheetRelationshipRoute | null>()
    for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
      const key = `${edge.id}\0${edge.source}\0${edge.target}`
      if (!cache.has(key)) {
        if (cache.size >= 512) cache.delete(cache.keys().next().value!)
        cache.set(key, routeSheetRelationship(edge.source, edge.target, nodes, {
          sourceFraction: slots.get(`${edge.id}:source`), targetFraction: slots.get(`${edge.id}:target`),
          reserved: [...cache.values()].filter((route): route is SheetRelationshipRoute => route !== null),
        }))
      }
      routed.set(edge.id, cache.get(key)!)
    }
    return edges.map(edge => {
      const route = routed.get(edge.id)
      return { ...edge, sourceHandle: route ? `source-${route.sourceSide}` : edge.sourceHandle,
        targetHandle: route ? `target-${route.targetSide}` : edge.targetHandle,
        data: { ...edge.data, sheetRelationship: true, sheetRoute: route } }
    })
  }
}

/** Include the actual gutter path, not just its two endpoint boxes. */
export function sheetRelationshipBounds(route: SheetRelationshipRoute, source: LivingRect, target: LivingRect): LivingRect {
  const xs = [source.x, source.x + source.width, target.x, target.x + target.width, ...route.points.map(p => p.x)]
  const ys = [source.y, source.y + source.height, target.y, target.y + target.height, ...route.points.map(p => p.y)]
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

export function sheetRelationshipInk(route: SheetRelationshipRoute, zoom: number) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const tip = route.points.at(-1)!, before = route.points.at(-2)!
  const length = Math.max(EPS, distance(tip, before))
  const dx = (tip.x - before.x) / length, dy = (tip.y - before.y) / length
  const arrowLength = Math.min(8 / scale, length * .8)
  const halfWidth = Math.min(3.5 / scale, arrowLength * .4375)
  const back = { x: tip.x - dx * arrowLength, y: tip.y - dy * arrowLength }
  return { strokeWidth: 1.25 / scale, dash: `${5 / scale} ${4 / scale}`, interactionWidth: 10 / scale, arrowLength,
    arrow: `M${tip.x} ${tip.y}L${back.x - dy * halfWidth} ${back.y + dx * halfWidth}L${back.x + dy * halfWidth} ${back.y - dx * halfWidth}Z` }
}
