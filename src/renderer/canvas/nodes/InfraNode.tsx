import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { InfraNodeData } from '../sceneTypes'
import { useInfraService } from '../../store/registryStore'
import { useGraphStore } from '../../store/graphStore'
import { monoFontFittingWidth } from '../systemChrome'
import { ROLE_LABEL, IMPLEMENTATION_LABEL, fileName } from '../infraRoles'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from './infraIcons'
import { EditableNodeTitle } from './EditableNodeTitle'
import { ShapeBackdrop } from './NodeShell'
import { fitPresentationScale } from '../resizeGeometry'
import { connectionHandleProps } from './connectionChrome'
import { AmbioNodeResizer } from './AmbioNodeResizer'

// Infra node - Category x Provider x Service (docs/INFRA.md).
// The CATEGORY drives the glyph and the legend label ("DATABASE · SQL"),
// the SERVICE's brand drives the icon and accent color, and STATUS renders
// proposals ghosted (dashed, dimmed) until confirmed. Drafting-table styling:
// monochrome single-path brand icons tinted with the brand accent, hairline
// borders, no glows.

interface InfraFacts { users: number; implementers: number; local: string | null; gaps: string[] }

/**
 * What the card says about its node: how many files use it and what fills it
 * locally. Read from the store rather than stamped into node data: infra nodes
 * are few, and this keeps the Floor projection free of per-edge bookkeeping.
 */
function useInfraFacts(id: string): InfraFacts {
  const counts = useGraphStore(state => {
    // Distinct files: one file writing three tables is one user.
    const users = new Set<string>()
    const implementers = new Set<string>()
    for (const dep of state.dependencies) {
      if (dep.dst !== id || dep.dstType !== 'infra' || dep.status === 'dismissed') continue
      if (dep.dependencyType === 'IMPLEMENTS') implementers.add(dep.src)
      else users.add(dep.src)
    }
    for (const src of implementers) users.delete(src)
    return `${users.size}:${implementers.size}`
  })
  const gapKey = useGraphStore(state => state.infraContents
    .filter(item => item.infraId === id && typeof item.detail?.warning === 'string')
    .map(item => `${item.name} is ${String(item.detail!.warning)}`)
    .join('\n'))
  const implementations = useGraphStore(state => state.infraNodes.find(node => node.id === id)?.implementations)
  return React.useMemo(() => {
    const [users, implementers] = counts.split(':').map(Number)
    const local = (implementations ?? [])
      .filter(impl => impl.kind !== 'vendor' && impl.environment === 'local')
      .map(impl => impl.ref.startsWith('compose:')
        ? `${impl.ref.slice(8)} (compose)`
        : `${fileName(impl.ref).replace(/\.[a-z]+$/, '')} ${impl.kind === 'in-process' ? 'stand-in' : IMPLEMENTATION_LABEL[impl.kind] ?? ''}`.trim())
      .join(' · ')
    return { users, implementers, local: local || null, gaps: gapKey ? gapKey.split('\n') : [] }
  }, [counts, implementations, gapKey])
}

export const InfraNode = React.memo(function InfraNode({ data, selected, width, height, isConnectable }: NodeProps) {
  const d = data as unknown as InfraNodeData
  const svc = useInfraService(d.service)
  const facts = useInfraFacts(d.id)
  const presentationScale = fitPresentationScale(width, height, 260, 160, d.worldScale ?? 1)
  const contentW = (typeof width === 'number' && width > 0 ? width : 260) / presentationScale
  const contentH = (typeof height === 'number' && height > 0 ? height : 160) / presentationScale

  if (!svc) return <div style={{
    width: '100%', height: '100%', position: 'relative', userSelect: 'none', cursor: 'grab',
  }}>
    {selected && (
      <AmbioNodeResizer nodeId={d.id} presentationScale={presentationScale} nodeWidth={width} nodeHeight={height} isVisible={selected}
        isResizable={typeof d.onResizeStart === 'function' && typeof d.onResizeEnd === 'function'}
        minWidth={1} minHeight={1} color="var(--accent)"
        onResizeStart={d.onResizeStart} onResizeEnd={d.onResizeEnd} />
    )}
    <div style={{
      width: `${100 / presentationScale}%`, height: `${100 / presentationScale}%`,
      transform: `scale(${presentationScale})`, transformOrigin: 'top left', position: 'relative',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 9, padding: '12px 28px',
    }}>
      <ShapeBackdrop stock="blueprint" shape="hexagon" stroke="var(--infra-border)" strokeWidth={1} fill="var(--infra-surface)" width={contentW} height={contentH} />
      <EditableNodeTitle value={d.name} onRename={d.onRename} style={{
        color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
        textAlign: 'center', maxWidth: '78%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} />
      {d.onChooseInfra && <button className="nodrag nopan" type="button" onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); d.onChooseInfra?.() }} style={{
          border: '1px solid var(--accent)', color: 'var(--accent)', background: 'var(--bg-raised)',
          padding: '5px 9px', fontSize: 9, fontWeight: 700, cursor: 'pointer',
        }}>Choose infrastructure</button>}
    </div>
    <Handle type="source" position={Position.Right} {...connectionHandleProps(isConnectable, presentationScale)} />
    <Handle type="target" position={Position.Left} {...connectionHandleProps(isConnectable, presentationScale)} />
  </div>

  const accent = svc?.brand.color ?? 'var(--infra-accent)'
  const officialIcon = svc ? officialServiceIcon(svc.id) : undefined
  const icon = svc ? brandIcon(svc.brand.icon) : null
  const glyph = CATEGORY_GLYPHS[d.category] ?? CATEGORY_GLYPHS.api
  const proposed = d.status === 'proposed'
  const shape = d.category === 'database' ? 'cylinder' as const : d.category === 'queue' ? 'hexagon' as const : 'box' as const
  const legend = [ROLE_LABEL[d.category] ?? d.category, d.subtype].filter(Boolean).join(' · ').toUpperCase()
  const padX = shape === 'hexagon' ? 30 : 18
  const nameFont = monoFontFittingWidth(d.name, contentW - padX * 2 - 40, 24)
  const users = facts.users
  const useLine = users > 0
    ? `${users} file${users === 1 ? '' : 's'} use${users === 1 ? 's' : ''} it`
    : facts.implementers > 0 ? `implemented in ${facts.implementers} file${facts.implementers === 1 ? '' : 's'}` : 'not connected yet'

  return (
    <div style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      cursor: 'grab',
      userSelect: 'none',
    }}>
      {selected && (
        <AmbioNodeResizer nodeId={d.id} presentationScale={presentationScale} nodeWidth={width} nodeHeight={height} isVisible={selected}
          isResizable={typeof d.onResizeStart === 'function' && typeof d.onResizeEnd === 'function'}
          minWidth={1} minHeight={1} color={accent}
          onResizeStart={d.onResizeStart} onResizeEnd={d.onResizeEnd} />
      )}
      <div
        className="ambio-infra-card"
        data-infra-card={d.service || d.category}
        style={{
          width: `${100 / presentationScale}%`,
          height: `${100 / presentationScale}%`,
          transform: `scale(${presentationScale})`,
          transformOrigin: 'top left',
          opacity: proposed ? 0.65 : 1,
          padding: shape === 'cylinder' ? `26px ${padX}px 14px` : `14px ${padX}px`,
          '--infra-accent-color': accent,
        } as React.CSSProperties}
      >
        <ShapeBackdrop stock="blueprint" shape={shape} stroke="var(--infra-border)" strokeWidth={1} dashed={proposed} fill="var(--infra-surface)" width={contentW} height={contentH} />
        <div className="ambio-infra-card__head">
          {officialIcon ? (
            <img src={officialIcon} width={30} height={30} alt="" className="ambio-infra-card__icon" />
          ) : icon ? (
            <svg viewBox="0 0 24 24" width={30} height={30} className="ambio-infra-card__icon" aria-label={icon.title}>
              <path d={icon.path} fill={accent} />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width={30} height={30} className="ambio-infra-card__icon" aria-hidden="true">
              <path d={glyph} fill="var(--text-secondary)" />
            </svg>
          )}
          <EditableNodeTitle value={d.name} onRename={d.onRename} style={{
            fontSize: nameFont,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            fontWeight: 700,
            lineHeight: 1.15,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }} />
        </div>
        <div className="ambio-infra-card__role">
          <svg viewBox="0 0 24 24" width={11} height={11} aria-hidden="true"><path d={glyph} fill="currentColor" /></svg>
          <span>{legend}</span>
          {proposed && <span className="ambio-infra-card__proposed">PROPOSED</span>}
        </div>
        <div className="ambio-infra-card__use">{useLine}</div>
        {facts.local && <div className="ambio-infra-card__local" title="What fills this role when you run the code locally">Locally: {facts.local}</div>}
        {facts.gaps.length > 0 && (
          <div className="ambio-infra-card__gap" title={facts.gaps.join('\n')}>
            {facts.gaps.length === 1 ? facts.gaps[0] : `${facts.gaps.length} things look wrong`}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} {...connectionHandleProps(isConnectable, presentationScale)} />
      <Handle type="target" position={Position.Top}    {...connectionHandleProps(isConnectable, presentationScale)} />
      <Handle type="source" position={Position.Right}  {...connectionHandleProps(isConnectable, presentationScale)} />
      <Handle type="target" position={Position.Left}   {...connectionHandleProps(isConnectable, presentationScale)} />
    </div>
  )
})
