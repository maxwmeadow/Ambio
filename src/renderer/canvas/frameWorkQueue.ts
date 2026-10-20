/** Ordered background work yields between messages. A single message remains
 * atomic; overflow asks the existing snapshot resync path to catch up. */
export function createFrameWorkQueue(options: {
  schedule: (run: () => void) => number; cancel: (id: number) => void; now: () => number
  budgetMs?: number; maxBatch?: number; maxPending?: number
  onBatch?: (count: number, pending: number) => void; onError?: (error: unknown) => void
}) {
  let pending: Array<() => void> = [], frame: number | null = null
  const flush = () => {
    frame = null
    const deadline = options.now() + (options.budgetMs ?? 3)
    let count = 0
    while (pending.length && count < (options.maxBatch ?? 24) && (count === 0 || options.now() < deadline)) {
      const work = pending.shift()!
      try { work() } catch (error) { options.onError?.(error) }
      count++
    }
    options.onBatch?.(count, pending.length)
    if (pending.length) frame = options.schedule(flush)
  }
  return {
    push(work: () => void) {
      if (pending.length >= (options.maxPending ?? 1024)) return false
      pending.push(work)
      if (frame === null) frame = options.schedule(flush)
      return true
    },
    clear() { if (frame !== null) options.cancel(frame); frame = null; pending = []; options.onBatch?.(0, 0) },
  }
}
