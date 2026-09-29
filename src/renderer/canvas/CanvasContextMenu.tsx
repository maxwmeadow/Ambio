import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { emitCommand } from '../app/commands'
import { useGraphStore } from '../store/graphStore'
import { raiseNotice } from '../store/interruptionStore.ts'

export type CanvasContextTarget =
  | { kind: 'file'; id: string }
  | { kind: 'system'; id: string }
  | { kind: 'infra'; id: string }
  | { kind: 'pane' }

interface Props {
  x: number
  y: number
  target: CanvasContextTarget
  onClose: () => void
  onShowDetails: (id: string) => void
  onZoomTo: (id: string) => void
}

interface Item { label: string; run: () => void; danger?: boolean }
type Entry = Item | 'separator'

function revealLabel(): string {
  const platform = window.axiom?.platform
  return platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Open Containing Folder'
}

function copy(text: string) {
  if (window.axiom?.copyText) void window.axiom.copyText(text)
  else void navigator.clipboard?.writeText(text)
}

/** Right-click menu for the live canvas. */
export function CanvasContextMenu({ x, y, target, onClose, onShowDetails, onZoomTo }: Props) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const entries = buildEntries(target, onShowDetails, onZoomTo)

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8),
    })
  }, [x, y])

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && menu.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', close)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', close)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  if (entries.length === 0) return null
  return (
    <div
      ref={menu}
      className="axiom-context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const buttons = [...(menu.current?.querySelectorAll('button') ?? [])]
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
            className={entry.danger ? 'axiom-context-menu__danger' : undefined}
            onClick={() => { onClose(); entry.run() }}
          >
            {entry.label}
          </button>
        ))}
    </div>
  )
}

function buildEntries(
  target: CanvasContextTarget,
  onShowDetails: (id: string) => void,
  onZoomTo: (id: string) => void,
): Entry[] {
  const store = useGraphStore.getState()
  const messageAgent: Item = {
    label: 'Message Agent About This…',
    run: () => window.dispatchEvent(new Event('axiom:open-agent-dispatch')),
  }

  if (target.kind === 'pane') {
    return [
      { label: 'New Sheet…', run: () => emitCommand('map.newSheet') },
      { label: 'Add Infrastructure…', run: () => emitCommand('map.addInfra') },
      'separator',
      { label: store.selectionMode ? 'Stop Lasso Select' : 'Lasso Select', run: () => emitCommand('map.lasso') },
      { label: 'Fit Map to Window', run: () => emitCommand('view.fitView') },
    ]
  }

  if (target.kind === 'file') {
    const file = store.files.find(candidate => candidate.id === target.id)
    if (!file) return []
    return [
      {
        label: 'Open in Editor',
        run: () => {
          void window.axiom?.openFile(file.path).then(result => {
            if (!result.ok) raiseNotice('open-in-editor', 'Could not open in an editor', result.detail)
          })
        },
      },
      { label: revealLabel(), run: () => window.axiom?.showInFolder(file.path) },
      'separator',
      { label: 'Copy Path', run: () => copy(file.path) },
      { label: 'Copy Relative Path', run: () => copy(file.relPath) },
      'separator',
      { label: 'Show Details', run: () => onShowDetails(file.id) },
      messageAgent,
    ]
  }

  if (target.kind === 'system') {
    const system = store.systems.find(candidate => candidate.id === target.id)
    if (!system) return []
    return [
      { label: 'Show Details', run: () => onShowDetails(system.id) },
      { label: 'Zoom to System', run: () => onZoomTo(system.id) },
      { label: 'Copy Name', run: () => copy(system.name) },
      'separator',
      messageAgent,
    ]
  }

  return [
    { label: 'Show Details', run: () => onShowDetails(target.id) },
    messageAgent,
  ]
}
