import { useCallback } from 'react'
import { useReactFlow, type FitViewOptions } from '@xyflow/react'

/** Viewport virtualization must never change what Fit means. Include buffered
 * off-screen nodes while excluding descendants hidden by semantic zoom. */
export function useCanvasFitView() {
  const { fitView, getNodes } = useReactFlow()
  return useCallback((options: FitViewOptions = {}) => fitView({
    ...options, includeHiddenNodes: true,
    nodes: options.nodes ?? getNodes().filter(node => !node.hidden || node.data.renderBudgetHidden),
  }), [fitView, getNodes])
}
