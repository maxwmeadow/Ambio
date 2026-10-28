/** Opt-in, bounded local stage tracing. Labels never include project/file data. */
export type PerfStage = 'snapshot.fetch' | 'snapshot.decode' | 'snapshot.store' | 'snapshot.batch' |
  'scene.initial-packing' | 'scene.geometry' | 'scene.floor-projection' |
  'scene.records' | 'scene.signature' | 'scene.visibility-project' | 'scene.canonical-preparation' | 'scene.integrity-preparation' |
  'worker.scene-post' | 'worker.index' | 'worker.query' | 'worker.round-trip' | 'worker.geometry-post' | 'worker.geometry' | 'scene.numeric-input'
export interface PerfSample { stage: PerfStage; ms: number; at: number; items?: number }
export function createPerfTrace(capacity = 2048, clock: () => number = () => performance.now()) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('trace capacity must be a positive integer')
  let events = false
  let enabled = false, samples: PerfSample[] = [], dropped = 0
  const totals = new Map<PerfStage, { count: number; totalMs: number; maxMs: number; maxItems: number }>()
  return {
    enabled: () => enabled,
    start(options: { events?: boolean } = {}) { events = Boolean(options.events); enabled = true; samples = []; totals.clear(); dropped = 0 },
    stop() { enabled = false; events = false },
    begin(stage: PerfStage, items?: number) {
      if (events && /^(snapshot\.(fetch|decode|store)|scene\.(geometry|initial-packing|floor-projection))/.test(stage))
        console.debug('AMBIO_PERF_STAGE', JSON.stringify({ stage, event: 'begin', items }))
    },
    record(stage: PerfStage, ms: number, items?: number) {
      if (!enabled || !Number.isFinite(ms) || ms < 0) return
      const total = totals.get(stage) ?? { count: 0, totalMs: 0, maxMs: 0, maxItems: 0 }
      total.count++; total.totalMs += ms; total.maxMs = Math.max(total.maxMs, ms)
      total.maxItems = Math.max(total.maxItems, items ?? 0); totals.set(stage, total)
      if (samples.length === capacity) { samples.shift(); dropped++ }
      if (events && /^(snapshot\.(fetch|decode|store)|scene\.(geometry|initial-packing|floor-projection))/.test(stage))
        console.debug('AMBIO_PERF_STAGE', JSON.stringify({ stage, event: 'end', ms, items }))
      samples.push({ stage, ms, at: clock(), ...(items === undefined ? {} : { items }) })
    },
    summary() {
      return { enabled, retained: samples.length, dropped,
        stages: Object.fromEntries([...totals].map(([stage, total]) => {
          const durations = samples.filter(s => s.stage === stage).map(s => s.ms).sort((a, b) => a - b)
          return [stage, { ...total, retainedSamples: durations.length,
            retainedP95Ms: durations[Math.floor(durations.length * .95)] ?? null }]
        })) }
    },
  }
}
export const perfTrace = createPerfTrace()
export function traceSync<T>(stage: PerfStage, run: () => T, items?: number): T {
  if (!perfTrace.enabled()) return run()
  perfTrace.begin(stage, items)
  const start = performance.now()
  try { return run() } finally { perfTrace.record(stage, performance.now() - start, items) }
}
export function beginPerfStage(stage: PerfStage, items?: number): () => void {
  if (!perfTrace.enabled()) return () => {}
  perfTrace.begin(stage, items)
  const start = performance.now()
  let finished = false
  return () => { if (!finished) { finished = true; perfTrace.record(stage, performance.now() - start, items) } }
}
;(globalThis as any).__ambioPerfTrace = perfTrace
