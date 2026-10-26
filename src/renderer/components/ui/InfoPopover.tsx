import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import '../../styles/infoPopover.css'

/** Top-layer help anchored to its button, independent of scroll-container layout. */
export function InfoPopover({ label, title, className, children }: {
  label: string
  title: string
  className?: string
  children: ReactNode
}) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const position = () => {
    const button = anchor.current, panel = popup.current
    if (!button || !panel || !panel.matches(':popover-open')) return
    const bounds = button.getBoundingClientRect()
    const margin = 12, gap = 10
    const width = Math.min(320, window.innerWidth - margin * 2)
    const above = bounds.top - margin - gap
    const below = window.innerHeight - bounds.bottom - margin - gap
    const side = above >= Math.min(160, below) ? 'top' : 'bottom'
    panel.style.width = `${width}px`
    panel.style.maxHeight = `${Math.max(0, side === 'top' ? above : below)}px`
    const height = panel.getBoundingClientRect().height
    const left = Math.max(margin, Math.min(bounds.right - width, window.innerWidth - margin - width))
    panel.style.left = `${left}px`
    panel.style.top = `${side === 'top' ? bounds.top - height - gap : bounds.bottom + gap}px`
    panel.style.setProperty('--info-arrow-x', `${Math.max(12, Math.min(width - 12, bounds.left + bounds.width / 2 - left))}px`)
    panel.dataset.side = side
    panel.style.visibility = 'visible'
  }
  useLayoutEffect(() => {
    const panel = popup.current
    if (!panel) return
    // React 18 predates typed popover props; use the native DOM properties.
    panel.popover = 'auto'
    anchor.current?.setAttribute('popovertarget', id)
    const toggle = () => {
      const shown = panel.matches(':popover-open')
      if (shown) position()
      else panel.style.visibility = 'hidden'
      setOpen(shown)
    }
    panel.addEventListener('toggle', toggle)
    return () => panel.removeEventListener('toggle', toggle)
  }, [id])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      popup.current?.hidePopover()
      anchor.current?.focus({ preventScroll: true })
    }
    const observer = new ResizeObserver(position)
    if (anchor.current) observer.observe(anchor.current)
    if (popup.current) observer.observe(popup.current)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  return <>
    <button ref={anchor} type="button" className={className} aria-label={label} aria-expanded={open} aria-controls={id}>i</button>
    <div ref={popup} id={id} role="region" aria-label={title} className="ambio-info-popover">
      <div className="ambio-info-popover__content">{children}</div>
    </div>
  </>
}
