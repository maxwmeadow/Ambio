import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { COMMANDS, buildMenu, type MenuPlatform, type SystemRole } from '../src/shared/appMenu'

export interface MenuState {
  projectOpen: boolean
  developer: boolean
}

export interface RecentProject { id: string; name: string; rootPath: string }

// Electron role names for the shared SystemRole vocabulary.
const ELECTRON_ROLE: Record<SystemRole, NonNullable<MenuItemConstructorOptions['role']>> = {
  undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', selectAll: 'selectAll',
  quit: 'quit', hide: 'hide', hideOthers: 'hideOthers', unhide: 'unhide', services: 'services',
  minimize: 'minimize', zoom: 'zoom', front: 'front', close: 'close',
  reload: 'reload', toggleDevTools: 'toggleDevTools',
}

/**
 * The native menu bar. Only macOS shows one: Windows and Linux use a custom
 * title bar, where the renderer draws the same menus. Command shortcuts are
 * displayed but not registered here - the renderer owns every command key, so
 * one key press can never run a command twice.
 */
export function applyApplicationMenu(getWindow: () => BrowserWindow | null, state: MenuState, recent: RecentProject[] = []): void {
  const platform = process.platform as MenuPlatform
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = buildMenu(platform, { developer: state.developer }).map(section => ({
    label: section.id === 'app' ? app.name : section.label,
    ...(section.id === 'window' ? { role: 'windowMenu' as const } : {}),
    ...(section.id === 'help' ? { role: 'help' as const } : {}),
    submenu: section.entries.map((entry): MenuItemConstructorOptions => {
      if (entry.kind === 'separator') return { type: 'separator' }
      if (entry.kind === 'recent') {
        return {
          label: 'Open Recent',
          submenu: [
            ...(recent.length > 0
              ? recent.map(project => ({
                label: project.name,
                sublabel: project.rootPath,
                click: () => getWindow()?.webContents.send('menu:open-recent', project.id),
              }))
              : [{ label: 'No Recent Projects', enabled: false }]),
            { type: 'separator' },
            {
              label: COMMANDS['project.clearRecent'].label,
              enabled: recent.length > 0,
              click: () => getWindow()?.webContents.send('menu:command', 'project.clearRecent'),
            },
          ],
        }
      }
      if (entry.kind === 'role') return { role: ELECTRON_ROLE[entry.role], label: entry.label }
      const spec = COMMANDS[entry.id]
      return {
        label: spec.label,
        accelerator: spec.accelerator,
        registerAccelerator: false,
        enabled: !spec.needsProject || state.projectOpen,
        click: () => getWindow()?.webContents.send('menu:command', spec.id),
      }
    }),
  }))
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Runs a system role for the menu the renderer draws on Windows and Linux. */
export function runMenuRole(window: BrowserWindow | null, role: SystemRole, developer: boolean): void {
  if (!window || window.isDestroyed()) return
  const contents = window.webContents
  switch (role) {
    case 'undo': contents.undo(); break
    case 'redo': contents.redo(); break
    case 'cut': contents.cut(); break
    case 'copy': contents.copy(); break
    case 'paste': contents.paste(); break
    case 'selectAll': contents.selectAll(); break
    case 'minimize': window.minimize(); break
    case 'close': window.close(); break
    case 'quit': app.quit(); break
    case 'reload': if (developer) contents.reload(); break
    case 'toggleDevTools': if (developer) contents.toggleDevTools(); break
    default: break
  }
}
