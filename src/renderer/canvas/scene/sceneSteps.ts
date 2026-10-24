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
