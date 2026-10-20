const ZOOM_CHROME_SELECTOR = [
  '.ambio-sheet-change-badge',
  '.ambio-surface-activity-pill',
  '.ambio-living-file-telemetry__badge',
  '.ambio-living-window-rail',
].join(',')

/**
 * Counter-scale only mounted activity chrome. A changing inherited variable
 * on the canvas root invalidates styles for the entire diagram on every frame,
 * even when it has no activity badges. Track mounts independently of the camera.
 */
export function canvasZoomChrome(root: HTMLElement, initialZoom: number) {
  const elements = new Set<HTMLElement>()
  let zoom = String(initialZoom)
  const paint = (element: HTMLElement) => {
    if (element.style.getPropertyValue('--ambio-zoom') !== zoom) {
      element.style.setProperty('--ambio-zoom', zoom)
    }
  }
  const collect = (element: Element) => {
    const candidates = element.matches(ZOOM_CHROME_SELECTOR)
      ? [element, ...element.querySelectorAll(ZOOM_CHROME_SELECTOR)]
      : element.querySelectorAll(ZOOM_CHROME_SELECTOR)
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || candidate.closest('[data-ambio-canvas]') !== root) continue
      elements.add(candidate)
      paint(candidate)
    }
  }
  collect(root)
  const observer = new MutationObserver(records => {
    for (const element of elements) {
      if (!root.contains(element)) elements.delete(element)
    }
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) collect(node)
    }
  })
  observer.observe(root, { childList: true, subtree: true })
  return {
    setZoom(next: number) {
      if (!Number.isFinite(next) || next <= 0 || zoom === String(next)) return
      zoom = String(next)
      for (const element of elements) paint(element)
    },
    dispose() {
      observer.disconnect()
      for (const element of elements) element.style.removeProperty('--ambio-zoom')
      elements.clear()
    },
  }
}
