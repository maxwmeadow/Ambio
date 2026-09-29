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
