export interface Point { x: number; y: number }
export interface ClipRect extends Point { width: number; height: number }
export interface ClippedEdgePart { path: string; startLength: number; endsAtTarget: boolean }

/** SmoothStep with radius zero emits M/L and degenerate Q commands. Accept only
 * straight, axis-aligned geometry; an unsupported future route stays untouched. */
export function orthogonalPoints(path: string): Point[] | null {
  if (/[^MLQ\s,]/.test(path.replace(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g, ''))) return null
  const tokens = path.match(/[MLQ]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g) ?? []
  const points: Point[] = []
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]
    if (command !== 'M' && command !== 'L' && command !== 'Q') return null
    if (command === 'M' ? points.length > 0 : points.length === 0) return null
    const x = Number(tokens[i++]), y = Number(tokens[i++])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const previous = points.at(-1)
    if (command === 'Q') {
      const endX = Number(tokens[i++]), endY = Number(tokens[i++])
      if (!previous || x !== previous.x || y !== previous.y || endX !== x || endY !== y) return null
      continue
    }
    if (previous && x !== previous.x && y !== previous.y) return null
    if (!previous || x !== previous.x || y !== previous.y) points.push({ x, y })
  }
  return points.length ? points : null
}

export function orthogonalLength(points: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y)
  return length
}

/** Clip before SVG tessellates the dashes. A clipPath alone still leaves the
 * million-unit source path to stroke. Preserve arc distance for dash phase and
 * never place an arrowhead at an artificial cut. */
export function clipOrthogonalEdge(points: readonly Point[], rect: ClipRect): ClippedEdgePart[] {
  const parts: ClippedEdgePart[] = []
  let distance = 0, last: Point | undefined
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const vertical = a.x === b.x
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    const start = vertical ? a.y : a.x, end = vertical ? b.y : b.x
    const near = vertical ? rect.y : rect.x
    const far = near + (vertical ? rect.height : rect.width)
    const cross = vertical ? a.x : a.y
    const crossNear = vertical ? rect.x : rect.y
    const crossFar = crossNear + (vertical ? rect.width : rect.height)
    const low = Math.max(Math.min(start, end), near), high = Math.min(Math.max(start, end), far)
    if (cross < crossNear || cross > crossFar || low > high || !length) { distance += length; last = undefined; continue }
    const first = end >= start ? low : high, final = end >= start ? high : low
    const p = vertical ? { x: a.x, y: first } : { x: first, y: a.y }
    const q = vertical ? { x: a.x, y: final } : { x: final, y: a.y }
    const segment = `L${q.x} ${q.y}`
    if (last?.x === p.x && last.y === p.y) parts[parts.length - 1].path += segment
    else parts.push({ path: `M${p.x} ${p.y}${segment}`, startLength: distance + Math.abs(first - start), endsAtTarget: false })
    parts[parts.length - 1].endsAtTarget = i === points.length - 1 && q.x === b.x && q.y === b.y
    last = q
    distance += length
  }
  return parts
}
