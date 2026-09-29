import fs from 'fs'
import { dirname } from 'path'

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState extends Rect { maximized: boolean; fullScreen?: boolean }

export function readWindowState(file: string): WindowState | null {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WindowState>
    const numbers = [state.x, state.y, state.width, state.height]
    if (!numbers.every(value => typeof value === 'number' && Number.isFinite(value))) return null
    return {
      x: state.x!, y: state.y!, width: state.width!, height: state.height!,
      maximized: Boolean(state.maximized), fullScreen: Boolean(state.fullScreen),
    }
  } catch {
    return null
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(state, null, 2))
    fs.renameSync(temp, file)
  } catch {
    // Remembering the window is a convenience; failing to must not matter.
  }
}

/**
 * The saved bounds, if enough of the window would still land on a connected
 * display to grab it. A monitor that was unplugged since last time must not
 * reopen Axiom off-screen.
 */
export function restorableBounds(
  state: WindowState | null,
  displays: Rect[],
  minimum: { width: number; height: number },
): Rect | null {
  if (!state) return null
  const width = Math.max(state.width, minimum.width)
  const height = Math.max(state.height, minimum.height)
  const visible = displays.some(display => {
    const overlapX = Math.min(state.x + width, display.x + display.width) - Math.max(state.x, display.x)
    const overlapY = Math.min(state.y + height, display.y + display.height) - Math.max(state.y, display.y)
    return overlapX >= 100 && overlapY >= 50
  })
  return visible ? { x: state.x, y: state.y, width, height } : null
}
