import type { CaseRun } from '../store/caseFile.ts'

/**
 * What the canvas draws for a call path or an investigation run, before any
 * geometry: which boxes to connect, what to call each line, and what to say
 * next to the functions the run was about.
 *
 * Pure so the rules that decide legibility (merge per visible pair, label
 * only what matters) are tested without a canvas.
 */

export interface TraceStepLike {
  callerFile: string
  callerSymbol: string
  calleeFile: string
  calleeSymbol: string
  callCount: number
  focus?: boolean
}

export interface TraceLine {
  key: string
  source: string
  target: string
  calls: number
  focus: boolean
  /** caller → callee, one per merged call, for the hover title. */
  pairs: string[]
  /** Short text drawn on the line; null for connective lines. */
  label: string | null
  /** The busiest focus function the line leads into. */
  focusSymbol: string | null
}

/**
 * One line per pair of visible boxes.
 *
 * Calls between files inside collapsed systems all land on the same two
 * boxes; drawing each as its own edge stacked identical lines and label chips
 * on one route. A call whose ends resolve to the same box is inside it and
 * is not a line at all.
 *
 * Only lines into a focus function carry a label: the name of that function
 * and how often it ran. Connective lines show the route and name their calls
 * on hover.
 */
export function mergeTraceLines(
  steps: readonly TraceStepLike[],
  visibleNodeId: (id: string) => string | null,
): TraceLine[] {
  const byPair = new Map<string, TraceLine & { focusNames: Map<string, number> }>()
  for (const step of steps) {
    const source = visibleNodeId(step.callerFile)
    const target = visibleNodeId(step.calleeFile)
    if (!source || !target || source === target) continue
    const key = `${source}>${target}`
    let line = byPair.get(key)
    if (!line) {
      line = { key, source, target, calls: 0, focus: false, pairs: [], label: null, focusSymbol: null, focusNames: new Map() }
      byPair.set(key, line)
    }
    line.calls += step.callCount
    line.pairs.push(`${step.callerSymbol} → ${step.calleeSymbol} ×${step.callCount}`)
    if (step.focus) {
      line.focus = true
      line.focusNames.set(step.calleeSymbol, (line.focusNames.get(step.calleeSymbol) ?? 0) + step.callCount)
    }
  }
  return [...byPair.values()].map(({ focusNames, ...line }) => {
    if (focusNames.size === 0) return line
    const [[name, calls]] = [...focusNames.entries()].sort((a, b) => b[1] - a[1])
    const more = focusNames.size > 1 ? ` +${focusNames.size - 1}` : ''
    return { ...line, label: `${name}${more} ×${calls}`, focusSymbol: name }
  })
}

export type CalloutTone = 'alert' | 'warn' | 'plain'

export interface RunCallout {
  key: string
  fileId: string
  symbol: string
  /** The file's name, shown when the callout sits on a closed system. */
  fileName: string
  calls: number
  errors: number
  /** The run's own words about this function, or null when it said nothing. */
  text: string | null
  tone: CalloutTone
}

/**
 * One callout per watched function: what the run established about it. The
 * text is the most severe finding on that function (falling back to one on
 * its file), with the code marks the case panel renders stripped for a
 * single line of prose.
 */
export function runCallouts(run: Pick<CaseRun, 'watched' | 'findings'> | null | undefined): RunCallout[] {
  if (!run) return []
  const rank = { high: 0, medium: 1, info: 2 } as const
  const findings = [...run.findings].sort((a, b) => rank[a.severity] - rank[b.severity])
  const out: RunCallout[] = []
  for (const w of run.watched) {
    const fileId = w.anchor?.fileId
    const symbol = w.anchor?.symbol ?? ''
    if (!fileId) continue
    const finding =
      findings.find(f => f.anchor?.fileId === fileId && f.anchor?.symbol === symbol) ??
      findings.find(f => f.anchor?.fileId === fileId && !f.anchor?.symbol)
    const tone: CalloutTone = w.errors > 0 || finding?.severity === 'high'
      ? 'alert'
      : finding?.severity === 'medium' ? 'warn' : 'plain'
    out.push({
      key: `${fileId}:${symbol}`,
      fileId,
      symbol,
      fileName: (w.anchor?.relPath ?? '').split('/').pop() ?? '',
      calls: w.calls,
      errors: w.errors,
      text: finding ? calloutText(finding.text, symbol) : null,
      tone,
    })
  }
  return out
}

export function stripCodeMarks(text: string): string {
  return text.replace(/`/g, '')
}

/**
 * A finding's headline, sized for a callout that already names the function:
 * "`effectivePricing` changes its argument `customer.pricing.tier` on 6 of 82
 * calls: "growth" → "partner", …" becomes "changes its argument
 * customer.pricing.tier on 6 of 82 calls". The values stay in the case panel.
 */
export function calloutText(text: string, symbol: string): string {
  // Cut at the first ": " or " - " outside code marks: a colon inside
  // `ValueError: cannot ship 9` is part of a value, not the end of a headline.
  let cut = text.length
  let inCode = false
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') inCode = !inCode
    else if (!inCode && i > 12 && (text.startsWith(': ', i) || text.startsWith(' - ', i))) {
      cut = i
      break
    }
  }
  let out = stripCodeMarks(text.slice(0, cut)).trim()
  if (symbol && out.startsWith(symbol + ' ')) out = out.slice(symbol.length + 1)
  return out
}

export interface Box { x: number; y: number; width: number; height: number }

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Where a callout goes around the box it describes: the first of a few
 * positions hugging that box that covers the least of everything else - other
 * boxes, and callouts already placed (which count heavily, since two callouts
 * on top of each other are both unreadable). Boxes that contain the anchor are
 * not obstacles; every position overlaps them equally.
 */
export function placeCallout(anchor: Box, size: { width: number; height: number }, obstacles: readonly Box[], placed: readonly Box[], gap: number): Box {
  const { width, height } = size
  const right = anchor.x + anchor.width
  const bottom = anchor.y + anchor.height
  const candidates: Box[] = [
    { x: right - width, y: anchor.y - height - gap, width, height },
    { x: right + gap, y: anchor.y, width, height },
    { x: anchor.x, y: anchor.y - height - gap, width, height },
    { x: right - width, y: bottom + gap, width, height },
    { x: anchor.x - width - gap, y: anchor.y, width, height },
  ]
  let best = candidates[0]
  let bestCost = Infinity
  for (const candidate of candidates) {
    let cost = 0
    for (const box of obstacles) cost += overlap(candidate, box)
    for (const box of placed) cost += overlap(candidate, box) * 20
    if (cost < bestCost - 1e-6) {
      best = candidate
      bestCost = cost
    }
  }
  return best
}

/** A callout's size on screen, before it renders: mono text at 11-12px. */
export function calloutScreenSize(callout: Pick<RunCallout, 'symbol' | 'fileName' | 'text'>, showFile: boolean): { width: number; height: number } {
  const CHAR = 6.9
  const head = callout.symbol.length + (showFile ? callout.fileName.length + 2 : 0) + 12
  const textChars = callout.text?.length ?? 0
  const width = Math.min(300, Math.max(head * CHAR, Math.min(textChars, 40) * CHAR) + 24)
  const lines = callout.text ? Math.min(2, Math.ceil((textChars * CHAR) / (width - 20))) : 0
  return { width, height: 30 + lines * 15 }
}
