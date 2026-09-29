import { useEffect, useRef } from 'react'
import type { CommandId } from '../../shared/appMenu'

// Commands travel as one DOM event, whatever started them - a key, the native
// menu, the title-bar menu or the palette - and whichever component owns the
// behaviour handles it. Nothing needs to know who else is listening.

const EVENT = 'axiom:command'

export function emitCommand(id: CommandId): void {
  window.dispatchEvent(new CustomEvent<CommandId>(EVENT, { detail: id }))
}

export function useCommandHandlers(handlers: Partial<Record<CommandId, () => void>>): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const listener = (event: Event) => {
      const id = (event as CustomEvent<CommandId>).detail
      latest.current[id]?.()
    }
    window.addEventListener(EVENT, listener)
    return () => window.removeEventListener(EVENT, listener)
  }, [])
}

export function currentPlatform(): 'darwin' | 'win32' | 'linux' {
  const platform = window.axiom?.platform ?? document.documentElement.dataset.platform
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux'
}

const OPEN_RECENT = 'axiom:open-recent'

/** Ask the app to open a project from Open Recent. */
export function requestOpenRecent(projectId: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_RECENT, { detail: projectId }))
}

/** Listens to Open Recent from both the title-bar menu and the native menu. */
export function useOpenRecent(handler: (projectId: string) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const listener = (event: Event) => latest.current((event as CustomEvent<string>).detail)
    window.addEventListener(OPEN_RECENT, listener)
    const unsubscribe = window.axiom?.onOpenRecent?.(projectId => latest.current(projectId))
    return () => {
      window.removeEventListener(OPEN_RECENT, listener)
      unsubscribe?.()
    }
  }, [])
}
