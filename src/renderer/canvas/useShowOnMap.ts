import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'

/**
 * Bring a node into view from outside the canvas (a chip in a reply, a row in
 * a review list), as search does: open its system if it is closed, select it,
 * and fly to it once it has a size - selecting reveals a card hidden at this
 * zoom, and React Flow cannot fit a node it has not measured.
 */
export function useShowOnMap(): (nodeId: string) => void {
  const { fitView, getInternalNode } = useReactFlow()
  return useCallback((nodeId: string) => {
    const graph = useGraphStore.getState()
    const systemId = graph.files.find(file => file.id === nodeId)?.systemId
    if (systemId && !graph.expandedSystemIds.has(systemId)) graph.toggleSystemExpanded(systemId)
    graph.setSelectedNode(nodeId)
    graph.setInspectedNode(nodeId)
    let tries = 0
    const fly = () => {
      if (getInternalNode(nodeId)?.measured.width || ++tries > 20) void fitView({ nodes: [{ id: nodeId }], duration: 850, padding: 0.5 })
      else setTimeout(fly, 50)
    }
    setTimeout(fly, 50)
  }, [fitView, getInternalNode])
}
