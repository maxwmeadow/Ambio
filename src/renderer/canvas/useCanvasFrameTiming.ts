import { useEffect } from 'react'
import { useStoreApi } from '@xyflow/react'
import { recordCameraFrame, getPerfMetrics } from './perfMetrics'

// Long tasks belong to the renderer, so multiple mounted canvases share one
// observer rather than counting each page entry once per surface.
let observing = 0, pageObserver: PerformanceObserver | undefined
function observeLongFrames() {
  if (++observing === 1) {
    try {
      const type = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame') ? 'long-animation-frame' : 'longtask'
      pageObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const metrics = getPerfMetrics()
          metrics.longAnimationFrames++
          metrics.longestAnimationFrame = Math.max(metrics.longestAnimationFrame, entry.duration)
        }
      })
      pageObserver.observe({ type })
    } catch { /* Older engines still have camera rAF measurements. */ }
  }
  return () => { if (--observing === 0) { pageObserver?.disconnect(); pageObserver = undefined } }
}

/** Observe navigation windows, with no idle RAF loop or uploaded telemetry. */
export function useCanvasFrameTiming() {
  const flow = useStoreApi()
  useEffect(() => {
    let frame = 0, lastMove = 0, previous = 0
    const sample = (now: number) => {
      frame = 0
      if (previous) recordCameraFrame(now - previous)
      previous = now
      if (now - lastMove < 250) frame = requestAnimationFrame(sample)
      else previous = 0
    }
    const unsubscribe = flow.subscribe((state, before) => {
      if (state.transform === before.transform) return
      lastMove = performance.now()
      if (!frame) { previous = lastMove; frame = requestAnimationFrame(sample) }
    })
    const stopObserving = observeLongFrames()
    return () => { unsubscribe(); cancelAnimationFrame(frame); stopObserving() }
  }, [flow])
}
