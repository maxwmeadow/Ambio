import React, { useLayoutEffect, useRef, useState } from 'react'
import { SYMBOL_ROW_HEIGHT, virtualRowRange } from '../virtualRows'

export function VirtualSymbolRows<T>({ rows, render, footer }: {
  rows: T[]; render: (row: T, index: number) => React.ReactNode; footer?: React.ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 80 })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => setView(previous => {
      const next = { top: element.scrollTop, height: element.clientHeight }
      const a = virtualRowRange(rows.length, previous.top, previous.height)
      const b = virtualRowRange(rows.length, next.top, next.height)
      return a.start === b.start && a.end === b.end && previous.height === next.height ? previous : next
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element); element.addEventListener('scroll', measure, { passive: true })
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure) }
  }, [rows.length])
  const range = virtualRowRange(rows.length, view.top, view.height)
  const indices = new Set(Array.from({ length: Math.max(0, range.end - range.start) }, (_, i) => i + range.start))
  // Retain a focused editor even if the user scrolls it out of the window.
  const focused = root.current?.contains(document.activeElement)
    ? (document.activeElement?.closest('[data-symbol-row]') as HTMLElement | null)?.dataset.symbolRow : undefined
  if (focused !== undefined && Number(focused) < rows.length) indices.add(Number(focused))
  return <div ref={root} className="symbol-scroll nodrag" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}
    onKeyDown={event => {
      if ((event.target as HTMLElement).matches('input, textarea')) return
      const current = Number((event.target as HTMLElement).closest<HTMLElement>('[data-symbol-row]')?.dataset.symbolRow)
      if (!Number.isFinite(current) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const next = Math.max(0, Math.min(rows.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1)))
      if (root.current) { root.current.scrollTop = next * SYMBOL_ROW_HEIGHT; setView({ top: root.current.scrollTop, height: root.current.clientHeight }) }
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-symbol-row="${next}"] [tabindex]`)?.focus({ preventScroll: true }))
    }}>
    <div style={{ height: range.totalHeight, position: 'relative' }}>
      {[...indices].map(index => <div key={index} data-symbol-row={index}
        style={{ position: 'absolute', top: index * SYMBOL_ROW_HEIGHT, left: 0, right: 0, height: SYMBOL_ROW_HEIGHT - 3 }}>
        {render(rows[index], index)}
      </div>)}
    </div>
    {footer}
  </div>
}
