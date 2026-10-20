// In-memory performance metrics harness for diagnostic tracing and automated benchmarks.

export interface AmbioPerfMetrics {
  canvasRenderCount: number
  zoomVisibilityPasses: number
  sheetLayoutBuilds: number
  budgetBatches: number
  budgetAdmissions: number
  maxBudgetBatch: number
  mountedRichNodes: number
  workerQueries: number
  workerFallbacks: number
  activeSymbolRequests: number
  maxSymbolRequests: number
  navigationFlights: number
  prefetchedTargets: number
  backgroundBatches: number
  maxBackgroundBatch: number
  pendingBackgroundMessages: number
  cameraFrames: number
  longestCameraFrame: number
  longAnimationFrames: number
  longestAnimationFrame: number
  resizerMounts: number
  resizerRenderCount: number
  symbolFetches: number
  symbolCacheHits: number
  symbolDeduplicatedRequests: number
}

const metrics: AmbioPerfMetrics = {
  canvasRenderCount: 0,
  zoomVisibilityPasses: 0,
  sheetLayoutBuilds: 0,
  budgetBatches: 0, budgetAdmissions: 0, maxBudgetBatch: 0, mountedRichNodes: 0, workerQueries: 0, workerFallbacks: 0,
  activeSymbolRequests: 0, maxSymbolRequests: 0,
  navigationFlights: 0, prefetchedTargets: 0,
  backgroundBatches: 0, maxBackgroundBatch: 0, pendingBackgroundMessages: 0,
  cameraFrames: 0, longestCameraFrame: 0, longAnimationFrames: 0, longestAnimationFrame: 0,
  resizerMounts: 0,
  resizerRenderCount: 0,
  symbolFetches: 0,
  symbolCacheHits: 0,
  symbolDeduplicatedRequests: 0,
}

if (typeof globalThis !== 'undefined') {
  ;(globalThis as any).__ambioPerfMetrics = metrics
}

export function getPerfMetrics(): AmbioPerfMetrics {
  return metrics
}

export function resetPerfMetrics(): void {
  metrics.canvasRenderCount = 0
  metrics.zoomVisibilityPasses = 0
  metrics.sheetLayoutBuilds = 0
  metrics.budgetBatches = 0
  metrics.budgetAdmissions = 0
  metrics.maxBudgetBatch = 0
  metrics.workerQueries = 0
  metrics.workerFallbacks = 0
  metrics.maxSymbolRequests = metrics.activeSymbolRequests
  metrics.navigationFlights = 0
  metrics.prefetchedTargets = 0
  metrics.backgroundBatches = 0
  metrics.maxBackgroundBatch = 0
  metrics.cameraFrames = 0
  metrics.longestCameraFrame = 0
  metrics.longAnimationFrames = 0
  metrics.longestAnimationFrame = 0
  cameraIntervals.length = 0
  metrics.resizerMounts = 0
  metrics.resizerRenderCount = 0
  metrics.symbolFetches = 0
  metrics.symbolCacheHits = 0
  metrics.symbolDeduplicatedRequests = 0
}

export function recordCanvasRender(): void {
  metrics.canvasRenderCount++
}

export function recordZoomVisibilityPass(): void {
  metrics.zoomVisibilityPasses++
}

export function recordSheetLayoutBuild(): void {
  metrics.sheetLayoutBuilds++
}

export function recordResizerRender(): void {
  metrics.resizerRenderCount++
}

export function recordResizerMount(delta: 1 | -1): void {
  metrics.resizerMounts += delta
}

export function recordSymbolFetch(): void {
  metrics.symbolFetches++
}

export function recordSymbolCacheHit(): void {
  metrics.symbolCacheHits++
}

export function recordSymbolDeduplication(): void {
  metrics.symbolDeduplicatedRequests++
}

const cameraIntervals: number[] = []
export function recordCameraFrame(ms: number) {
  if (ms < 0 || !Number.isFinite(ms)) return
  metrics.cameraFrames++
  metrics.longestCameraFrame = Math.max(metrics.longestCameraFrame, ms)
  if (cameraIntervals.length === 512) cameraIntervals.shift()
  cameraIntervals.push(ms)
}
export function cameraFrameSummary() {
  const sorted = [...cameraIntervals].sort((a, b) => a - b)
  return { samples: sorted.length, p95: sorted[Math.floor(sorted.length * .95)] ?? 0,
    p99: sorted[Math.floor(sorted.length * .99)] ?? 0, max: metrics.longestCameraFrame }
}
;(globalThis as any).__ambioCameraFrameSummary = cameraFrameSummary

