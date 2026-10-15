import { useEffect, useState } from 'react'

/** How long a side panel takes to leave; matches --panel-exit in global.css. */
export const PANEL_EXIT_MS = 150

/**
 * Keeps a panel mounted for its closing animation. `mounted` says whether to
 * render at all; `closing` is true for the frames between being asked to
 * close and being gone, when the panel should play its exit and ignore input.
 * With reduced motion there is no exit to wait for.
 */
export function usePresence(open: boolean, exitMs = PANEL_EXIT_MS): { mounted: boolean; closing: boolean } {
  const [lingering, setLingering] = useState(open)
  useEffect(() => {
    if (open) { setLingering(true); return }
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (still) { setLingering(false); return }
    const timer = window.setTimeout(() => setLingering(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [open, exitMs])
  return { mounted: open || lingering, closing: !open && lingering }
}
