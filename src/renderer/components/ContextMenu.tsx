import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  label: string
  run: () => void
  danger?: boolean
  disabled?: boolean
  /** The keyboard shortcut that does the same, shown beside the label. */
  shortcut?: string
}
export type ContextMenuEntry = ContextMenuItem | 'separator'

/** A right-click menu at a point, kept inside the window; Escape, a click elsewhere or scrolling closes it. */
export function ContextMenu({ x, y, entries, onClose, label }: { x: number; y: number; entries: ContextMenuEntry[]; onClose: () => void; label?: string }) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    })
  }, [x, y])

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && menu.current?.contains(event.target as Node)) return
      // Escape closes the menu, not what the menu was opened over.
      if (event instanceof KeyboardEvent) { event.preventDefault(); event.stopPropagation() }
      onClose()
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', close, true)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  if (entries.length === 0) return null
  return (
    <div
      ref={menu}
      className="ambio-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
        next?.focus()
      }}
    >
      {entries.map((entry, index) => entry === 'separator'
        ? <hr key={`separator-${index}`} />
        : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={entry.danger ? 'ambio-context-menu__danger' : undefined}
            onClick={() => { onClose(); entry.run() }}
          >
            <span>{entry.label}</span>
            {entry.shortcut && <kbd className="ambio-context-menu__shortcut">{entry.shortcut}</kbd>}
          </button>
        ))}
    </div>
  )
}
