import { useCallback } from 'react'
import { getViewportForBounds, useReactFlow, useStoreApi, type FitViewOptions } from '@xyflow/react'
import { canvasScene, canonicalBounds } from './scene/canonicalScene'

/** Viewport virtualization must never change what Fit means. Include buffered
 * off-screen nodes while excluding descendants hidden by semantic zoom. */
export function useCanvasFitView() {
  const { fitView, getNodes, getInternalNode, setViewport } = useReactFlow()
  const store = useStoreApi()
  return useCallback((options: FitViewOptions = {}) => {
    const scene = canvasScene(store)
    // Explicit mounted targets still use Flow's measurement-aware fit queue.
    // Whole-scene Fit must not adopt every offscreen entity to find its bounds.
    if (scene && (!options.nodes || options.nodes.some(node => !getInternalNode(node.id)))) {
      const bounds = canonicalBounds(scene, options.nodes?.map(node => node.id))
      const state = store.getState()
      if (!bounds || !state.width || !state.height) return Promise.resolve(false)
      const viewport = getViewportForBounds(bounds, state.width, state.height,
        options.minZoom ?? state.minZoom, options.maxZoom ?? state.maxZoom, options.padding ?? .1)
      return setViewport(viewport, { duration: options.duration, ease: options.ease, interpolate: options.interpolate })
    }
    return fitView({ ...options, includeHiddenNodes: true,
      nodes: options.nodes ?? getNodes().filter(node => !node.hidden || node.data.renderBudgetHidden) })
  }, [fitView, getNodes, getInternalNode, setViewport, store])
}
