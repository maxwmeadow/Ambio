import { useCallback } from 'react'
import { useReactFlow, useStoreApi } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'

/**
 * Bring a node into view from outside the canvas (a chip in a reply, a row in
 * a review list), as search does: open its system if it is closed, select it,
 * and fly to it once it has a size - selecting reveals a card hidden at this
 * zoom, and React Flow cannot fit a node it has not measured.
 */
const navigationRequests = new WeakMap<object, number>()

export function useShowOnMap(inspect = true): (nodeId: string) => void {
  const { fitView, getInternalNode } = useReactFlow()
  const flowStore = useStoreApi()
  return useCallback((nodeId: string) => {
    const request = (navigationRequests.get(flowStore) ?? 0) + 1
    navigationRequests.set(flowStore, request)
    // A wheel easing loop must yield to this camera flight. Dispatch on this
    // React Flow surface so a nested bin cannot cancel another canvas's camera.
    flowStore.getState().domNode?.dispatchEvent(new Event('ambio:camera-navigation', { bubbles: true }))
    const graph = useGraphStore.getState()
    const systemId = graph.files.find(file => file.id === nodeId)?.systemId
    if (systemId && !graph.expandedSystemIds.has(systemId)) graph.toggleSystemExpanded(systemId)
    graph.setSelectedNode(nodeId)
    if (inspect) graph.setInspectedNode(nodeId)
    const deadline = performance.now() + 1000
    const fly = () => {
      if (navigationRequests.get(flowStore) !== request) return
      const node = getInternalNode(nodeId)
      if (node && !node.hidden && node.measured.width) void fitView({ nodes: [{ id: nodeId }], duration: 850, padding: 0.5 })
      else if (performance.now() < deadline) requestAnimationFrame(fly)
    }
    requestAnimationFrame(fly)
  }, [fitView, getInternalNode, flowStore, inspect])
}
