import { BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

// Updates come from GitHub Releases (see "publish" in package.json).
//
// Windows and Linux (AppImage) download in the background and install on
// the next restart. macOS cannot auto-install until the app is signed with an
// Apple Developer ID - Squirrel.Mac refuses unsigned updates - so there Ambio
// only says a new version exists and links to the download.

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string; manual: boolean }
  | { state: 'ready'; version: string }

export const RELEASES_URL = 'https://github.com/maxwmeadow/Ambio/releases/latest'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 15_000

let status: UpdateStatus = { state: 'idle' }

export type UpdateCheckResult = 'up-to-date' | 'available' | 'unavailable' | 'failed'

export function initUpdates(
  getWindow: () => BrowserWindow | null,
  enabled: boolean,
  automaticChecks: () => boolean,
): void {
  ipcMain.handle('update:get-status', () => status)
  ipcMain.handle('update:install', () => {
    if (status.state === 'ready') {
      autoUpdater.quitAndInstall()
      return
    }
    void shell.openExternal(RELEASES_URL)
  })
  // A check the user asked for, so it reports back even when there is nothing new.
  ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
    if (!enabled) return 'unavailable'
    try {
      const result = await autoUpdater.checkForUpdates()
      return result?.isUpdateAvailable ? 'available' : 'up-to-date'
    } catch (error) {
      console.warn('[updates] manual check failed:', error instanceof Error ? error.message : error)
      return 'failed'
    }
  })

  if (!enabled) return

  const manual = process.platform === 'darwin' ||
    (process.platform === 'linux' && !process.env.APPIMAGE)
  autoUpdater.autoDownload = !manual
  autoUpdater.autoInstallOnAppQuit = !manual
  autoUpdater.logger = {
    info: (message: unknown) => console.log('[updates]', message),
    warn: (message: unknown) => console.warn('[updates]', message),
    error: (message: unknown) => console.error('[updates]', message),
    debug: () => {},
  }

  const publish = (next: UpdateStatus) => {
    status = next
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('update:status', status)
  }
  autoUpdater.on('update-available', info => {
    if (manual) publish({ state: 'available', version: info.version, manual: true })
  })
  autoUpdater.on('update-downloaded', info => publish({ state: 'ready', version: info.version }))
  // A failed check is never the user's problem: offline, rate-limited, or no
  // release yet. It is logged and retried on the next interval.
  autoUpdater.on('error', error => console.warn('[updates] check failed:', error?.message ?? error))

  setTimeout(() => { if (automaticChecks()) void check() }, FIRST_CHECK_DELAY_MS)
  setInterval(() => { if (automaticChecks()) void check() }, CHECK_INTERVAL_MS)
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.warn('[updates] check failed:', error instanceof Error ? error.message : error)
  }
}
