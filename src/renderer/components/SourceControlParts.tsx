import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitIcon } from './GitIcon'

/* The source control panel's small parts, shared by the branch menu
   (BranchChip) and its changes list (SourceControlChanges). */

/** How long the pointer rests on an icon button before its label shows. */
const TIP_DELAY_MS = 350

/**
 * A square icon button, named for screen readers and in a label that shows
 * while it is hovered or focused, so no icon is a guess. The label is drawn
 * over everything, outside the popover's scrolling body, so it is never
 * clipped.
 */
export function ToolButton({ icon, label, hint, onClick, disabled, danger, spinning }: {
  icon: React.ComponentProps<typeof GitIcon>['name']; label: string; hint?: string; onClick: () => void
  disabled?: boolean; danger?: boolean; spinning?: boolean
}) {
  const [tip, setTip] = useState<{ x: number; y: number; above: boolean } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (target: HTMLElement, delay: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const bounds = target.getBoundingClientRect()
      const above = bounds.bottom + 60 > window.innerHeight
      setTip({ x: bounds.left + bounds.width / 2, y: above ? bounds.top - 6 : bounds.bottom + 6, above })
    }, delay)
  }
  const hide = () => { window.clearTimeout(timer.current); setTip(null) }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <>
      <button type="button" className="ambio-tool" aria-label={label}
        data-danger={danger || undefined} disabled={disabled}
        onPointerEnter={event => show(event.currentTarget, TIP_DELAY_MS)} onPointerLeave={hide}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, 0) }} onBlur={hide}
        onClick={() => { hide(); onClick() }}>
        <GitIcon name={icon} size={16} className={spinning ? 'ambio-tool__spin' : undefined} />
      </button>
      {tip && createPortal(
        <div className="ambio-tool-tip" role="tooltip" data-above={tip.above || undefined}
          style={{ '--ambio-tip-x': `${tip.x}px`, '--ambio-tip-y': `${tip.y}px` } as React.CSSProperties}>
          <strong>{label}</strong>{hint && <span>{hint}</span>}
        </div>,
        document.body,
      )}
    </>
  )
}

/** A section heading in the sheet rail's manner: small caps, a rule, a count. */
export function SectionLabel({ children, count, tools }: { children: React.ReactNode; count?: number; tools?: React.ReactNode }) {
  return (
    <h3 className="ambio-scm__section">
      <span>{children}</span>
      <span className="ambio-scm__rule" aria-hidden="true" />
      {count !== undefined && <span className="ambio-scm__count">{count}</span>}
      {tools && <span className="ambio-scm__section-tools">{tools}</span>}
    </h3>
  )
}

