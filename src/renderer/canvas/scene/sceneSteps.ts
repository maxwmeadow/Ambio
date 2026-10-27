/** Run pure preparation in small tasks; publish only the completed result. */
export async function runSceneSteps<T>(steps: Generator<unknown, T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    const deadline = performance.now() + 3
    do {
      if (signal?.aborted) throw new DOMException('Superseded scene preparation', 'AbortError')
      const result = steps.next()
      if (result.done) return result.value
    } while (performance.now() < deadline)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

/** Stable sorting without a project-sized atomic Array.sort. Each native sort
 * handles at most 256 entries; merging yields at the same item checkpoints as
 * the rest of scene preparation. The caller owns the unpublished array. */
export function* sortSceneSteps<T>(rows: T[], compare: (a: T, b: T) => number): Generator<void, T[]> {
  const chunk = 256
  if (rows.length <= chunk) return rows.sort(compare)
  for (let start = 0; start < rows.length; start += chunk) {
    const sorted = rows.slice(start, start + chunk).sort(compare)
    for (let i = 0; i < sorted.length; i++) rows[start + i] = sorted[i]
    yield
  }
  let source = rows, target = new Array<T>(rows.length), work = 0
  for (let width = chunk; width < rows.length; width *= 2) {
    for (let start = 0; start < rows.length; start += width * 2) {
      const middle = Math.min(start + width, rows.length), end = Math.min(start + width * 2, rows.length)
      let left = start, right = middle
      for (let at = start; at < end; at++) {
        // Treat a NaN comparison like Array.sort's equality result too.
        target[at] = right >= end || (left < middle && !(compare(source[left], source[right]) > 0))
          ? source[left++] : source[right++]
        if ((++work & 255) === 0) yield
      }
    }
    const next = source
    source = target
    target = next
  }
  return source
}
