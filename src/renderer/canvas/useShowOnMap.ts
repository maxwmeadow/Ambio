import { useCallback } from 'react'
import { useReactFlow, useStoreApi } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'
import { fetchFileSymbols } from './symbolCache'
import { getPerfMetrics } from './perfMetrics'

export interface FlightOptions { duration?: number; maxZoom?: number; minZoom?: number; padding?: number }

const navigationRequests = new WeakMap<object, number>()
const navigationPrefetches = new WeakMap<object, AbortController>()

/**
 * Fly this React Flow surface to a node once it can be fitted. The caller has
 * already selected it, which reveals a node hidden at this zoom (see
 * revealNodePath); React Flow cannot fit a node that is hidden or unmeasured,
 * so the flight waits for both. A newer flight on the same surface, or
 * `stillWanted` turning false, supersedes this one.
 */
export function useFlyToNode(options: FlightOptions = {}): (nodeId: string, stillWanted?: () => boolean) => void {
  const { fitView, getInternalNode } = useReactFlow()
  const flowStore = useStoreApi()
  const duration = options.duration ?? 850, padding = options.padding ?? .5, maxZoom = options.maxZoom, minZoom = options.minZoom
  return useCallback((nodeId: string, stillWanted?: () => boolean) => {
    const key = flowStore.getState
    const request = (navigationRequests.get(key) ?? 0) + 1
    navigationRequests.set(key, request)
    // A wheel easing loop must yield to this camera flight. Dispatch on this
    // React Flow surface so a nested bin cannot cancel another canvas's camera.
    flowStore.getState().domNode?.dispatchEvent(new Event('ambio:camera-navigation', { bubbles: true }))
    const deadline = performance.now() + 30000
    const fly = () => {
      if (navigationRequests.get(key) !== request || (stillWanted && !stillWanted())) return
      const preparing = flowStore.getState().domNode?.closest('[data-ambio-canvas]')?.getAttribute('data-scene-preparing') === 'true'
      const node = getInternalNode(nodeId)
      if (!preparing && node && !node.hidden && node.measured.width) {
        getPerfMetrics().navigationFlights++
        flowStore.getState().domNode?.dispatchEvent(new CustomEvent('ambio:camera-prewarm', { bubbles: true, detail: { nodeId, duration } }))
        void fitView({ nodes: [{ id: nodeId }], duration, padding, maxZoom, minZoom })
      }
      else if (performance.now() < deadline) requestAnimationFrame(fly)
    }
    requestAnimationFrame(fly)
  }, [fitView, getInternalNode, flowStore, duration, padding, maxZoom, minZoom])
}

/**
 * Bring a Floor node into view from outside the canvas (a chip in a reply, a
 * row in a review list), as search does: open its system if it is closed,
 * select it, and fly to it once it has a size.
 */
export function useShowOnMap(inspect = true, options: FlightOptions = {}): (nodeId: string) => void {
  const flowStore = useStoreApi()
  const flyToNode = useFlyToNode(options)
  return useCallback((nodeId: string) => {
    const key = flowStore.getState
    navigationPrefetches.get(key)?.abort()
    const prefetch = new AbortController()
    navigationPrefetches.set(key, prefetch)
    const graph = useGraphStore.getState()
    const systemId = graph.files.find(file => file.id === nodeId)?.systemId
    if (systemId && !graph.expandedSystemIds.has(systemId)) graph.toggleSystemExpanded(systemId)
    graph.setSelectedNode(nodeId)
    if (inspect) graph.setInspectedNode(nodeId)
    if (graph.currentProject && graph.files.some(file => file.id === nodeId)) {
      getPerfMetrics().prefetchedTargets++
      void fetchFileSymbols(graph.currentProject.id, nodeId, prefetch.signal).catch(() => {})
    }
    flyToNode(nodeId, () => {
      if (useGraphStore.getState().currentProject?.id === graph.currentProject?.id) return true
      prefetch.abort()
      return false
    })
  }, [flowStore, flyToNode, inspect])
}
