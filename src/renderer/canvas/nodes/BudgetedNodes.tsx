import React from 'react'
import { Handle, Position, useStoreApi, type NodeProps } from '@xyflow/react'
import { useNodeRenderTier } from '../useCanvasRenderBudget'
import { REVEAL_MOTION, revealEntranceElapsed } from '../semanticZoom'
import { ShapeBackdrop } from './NodeShell'
import { LanguageIcon } from '../languages'
import { fitPresentationScale } from '../resizeGeometry'
import { connectionHandleProps } from './connectionChrome'
import { FileNode } from './FileNode'
import { SystemNode } from './SystemNode'
import { InfraNode } from './InfraNode'
import { getPerfMetrics } from '../perfMetrics'
import { SheetChangeBadge } from './SheetChangeBadge'
import { BranchOverlayMark } from './BranchOverlayMark'
import { useCheckoutStore } from '../../store/checkoutStore'

function CompactBranchMark({ id }: { id: string }) {
  const marks = useCheckoutStore(state => state.overlayByFile.get(id))
  return <BranchOverlayMark marks={marks} />
}

/** Geometry and a cheap identity remain available while rich content waits for
 * admission. Selection/hover/activity promotes the actual editable component. */
function CompactNode(props: NodeProps & { silhouette: boolean; promote: () => void }) {
  const d = props.data
  const width = props.width ?? 220, height = props.height ?? 110
  const system = props.type === 'system'
  const file = props.type === 'file'
  const shape = system ? 'folder' : d.shape === 'class' ? 'classbox'
    : d.shape === 'cylinder' || d.shape === 'hexagon' ? d.shape : 'box'
  const scale = file ? fitPresentationScale(width, height, 220, 110, Number(d.worldScale ?? 1)) : 1
  const label = String(d.name ?? d.label ?? '')
  const color = String(d.color ?? 'var(--border)')
  return <div data-render-tier={props.silhouette ? 'silhouette' : 'identity'} title={label}
    onPointerEnter={props.promote} style={{ position: 'relative', width: '100%', height: '100%',
      opacity: d.dimmed ? (system ? .3 : .22) : 1 }}>
    <SheetChangeBadge change={d.sheetChange} width={width} />
    {file && <CompactBranchMark id={String(d.sourceFileId ?? props.id)} />}
    <div style={{ position: 'absolute', inset: 0, width: `${100 / scale}%`, height: `${100 / scale}%`,
      transform: `scale(${scale})`, transformOrigin: 'top left', isolation: 'isolate' }}>
      <ShapeBackdrop shape={shape} fill="var(--bg-surface)" stroke={color} width={width / scale} height={height / scale} />
      {!props.silhouette && <div style={{ position: 'absolute', inset: file ? '10px 14px' : '18px 12px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
        pointerEvents: 'none', overflow: 'hidden', textAlign: 'center', color: 'var(--text-primary)' }}>
        {file && <LanguageIcon language={String(d.language ?? '')} size={30} />}
        <span title={String(d.relPath ?? label)} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontWeight: 700,
          fontSize: file ? 19 : Math.min(height * .12, width / Math.max(8, label.length * .65)),
          lineHeight: 1.1, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{label}</span>
      </div>}
    </div>
    {!d.omitConnectionHandles && (['source', 'target'] as const).flatMap(type => [
      <Handle key={type + '-top'} id={type + '-top'} type={type} position={Position.Top} {...connectionHandleProps(props.isConnectable, scale)} />,
      <Handle key={type + '-right'} id={type + '-right'} type={type} position={Position.Right} {...connectionHandleProps(props.isConnectable, scale)} />,
      <Handle key={type + '-bottom'} id={type + '-bottom'} type={type} position={Position.Bottom} {...connectionHandleProps(props.isConnectable, scale)} />,
      <Handle key={type + '-left'} id={type + '-left'} type={type} position={Position.Left} {...connectionHandleProps(props.isConnectable, scale)} />,
    ])}
  </div>
}

/**
 * A node that semantic zoom just brought out of hiding fades in once its parent
 * system's name has cleared (REVEAL_MOTION). It mounts already visible, so a
 * CSS transition never runs; the entrance is played on React Flow's wrapper on
 * mount, from where the reveal is now. A node merely scrolled into view, or
 * remounted later, has no entrance left to play.
 */
function useRevealEntrance(id: string, revealedAt: unknown) {
  const flow = useStoreApi()
  React.useLayoutEffect(() => {
    const elapsed = revealEntranceElapsed(revealedAt, performance.now())
    if (elapsed === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const wrapper = flow.getState().domNode?.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    const entrance = wrapper?.animate([{ opacity: 0 }, { opacity: 1 }], {
      delay: REVEAL_MOTION.contentDelayMs,
      duration: REVEAL_MOTION.contentInMs,
      easing: REVEAL_MOTION.easeOut,
      fill: 'backwards',
    })
    if (entrance) entrance.currentTime = elapsed
    return () => entrance?.cancel()
    // Mount only: an entrance belongs to the reveal that mounted this node.
  }, [])
}

function budgeted(Component: React.ComponentType<NodeProps>) {
  return React.memo(function BudgetedNode(props: NodeProps) {
    useRevealEntrance(props.id, props.data.revealedAt)
    const { tier, promote } = useNodeRenderTier(props.id)
    const d = props.data
    // Active visual signals and gesture chrome retain their full fidelity.
    const immediate = props.selected || props.dragging || d.fx || d.agentReading || (d.agentPresence as unknown[] | undefined)?.length ||
      d.runtime || (d.livingWindows as unknown[] | undefined)?.length || d.deltaMark || d.isDropTarget || d.relationshipFocus
    const full = Boolean(immediate || tier === 2 || (props.type !== 'file' && tier >= 1))
    React.useEffect(() => {
      const metrics = getPerfMetrics()
      metrics.mountedRichNodes += Number(full)
      return () => { metrics.mountedRichNodes -= Number(full) }
    }, [full])
    return full ? <Component {...props} /> : <CompactNode {...props} silhouette={tier === 0} promote={promote} />
  })
}
export const BudgetedFileNode = budgeted(FileNode)
export const BudgetedSystemNode = budgeted(SystemNode)
export const BudgetedInfraNode = budgeted(InfraNode)
