/** DOM counts alone miss subscribed components that return null. Inspect the
 * current React tree in tests, using wrapper props rather than minified names.
 * The assertions also require nonzero counts so a vendor change cannot make a
 * broken detector silently pass. This adds no production instrumentation. */
export function canvasComponentCounts() {
  const element = document.querySelector('.react-flow') as any
  const key = element && Object.keys(element).find(key => key.startsWith('__reactFiber$'))
  let root = key ? element[key] : null
  if (!root) throw Error('React canvas fiber unavailable')
  while (root.return) root = root.return
  root = root.stateNode?.current ?? root
  const pending = [root]
  let wrappers = 0, minimapWrappers = 0, canonicalNodes = 0
  while (pending.length) {
    const fiber = pending.pop()!
    const props = fiber.memoizedProps
    if (typeof props?.id === 'string' && 'resizeObserver' in props && 'nodeTypes' in props) wrappers++
    if (typeof props?.id === 'string' && 'nodeColorFunc' in props) minimapWrappers++
    if (Array.isArray(props?.nodes) && 'nodeTypes' in props) canonicalNodes = Math.max(canonicalNodes, props.nodes.length)
    if (fiber.child) pending.push(fiber.child)
    if (fiber.sibling) pending.push(fiber.sibling)
  }
  return { wrappers, minimapWrappers, canonicalNodes, domNodes: document.querySelectorAll('.react-flow__node').length }
}

/** Optional bounded camera-intent trace for diagnosing competing fits. */
export function installCanvasCameraTrace(interruptQueuedFit = false) {
  const element = document.querySelector('.react-flow') as any
  const key = element && Object.keys(element).find(key => key.startsWith('__reactFiber$'))
  let root = key ? element[key] : null
  if (!root) throw Error('React canvas fiber unavailable')
  while (root.return) root = root.return
  const pending = [root.stateNode?.current ?? root]
  while (pending.length) {
    const fiber = pending.pop()!
    const store = fiber.memoizedProps?.value
    if (typeof store?.getState === 'function' && store.getState().domNode === element) {
      const panZoom = store.getState().panZoom
      const original = panZoom.setViewport
      const events: any[] = []
      ;(window as any).__canvasCameraTrace = events
      if (interruptQueuedFit) {
        const stop = store.subscribe((state: any) => {
          if (!state.fitViewQueued || state.fitViewOptions?.duration !== 850) return
          stop()
          const graph = (window as any).__ambioGraphStore
          const selected = graph.getState().selectedNodeId
          graph.setState({ nodeFx: { ...graph.getState().nodeFx, [selected]: { kind: 'edit', key: Date.now() } } })
          ;(window as any).__canvasFitInterrupted = true
        })
      }
      panZoom.setViewport = function(...args: any[]) {
        const state = store.getState()
        const selected = (window as any).__ambioGraphStore.getState().selectedNodeId
        const node = state.nodeLookup.get(selected)
        if (events.length === 128) events.shift()
        events.push({ at: performance.now(), viewport: args[0], options: args[1], selected,
          surface: { width: state.width, height: state.height, actualWidth: element.clientWidth },
          node: node ? { position: node.internals.positionAbsolute, measured: node.measured, style: node.style } : null,
          stack: Error().stack?.slice(0, 2500) })
        return original.apply(this, args)
      }
      return
    }
    if (fiber.child) pending.push(fiber.child)
    if (fiber.sibling) pending.push(fiber.sibling)
  }
  throw Error('Canvas store unavailable')
}
