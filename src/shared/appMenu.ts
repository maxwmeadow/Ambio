// The application's commands and menus, described once.
//
// Every surface reads this: the native macOS menu bar, the menu bar drawn in
// the custom title bar on Windows and Linux, the command palette, keyboard
// shortcuts and the shortcut reference. A command added here appears in all
// of them, with the same name and the same key.

export type CommandId =
  | 'app.about'
  | 'app.settings'
  | 'app.checkUpdates'
  | 'project.new'
  | 'project.open'
  | 'project.reveal'
  | 'project.settings'
  | 'project.reindex'
  | 'project.close'
  | 'view.commandPalette'
  | 'view.search'
  | 'view.fitView'
  | 'view.agentLog'
  | 'view.documents'
  | 'view.reviewChanges'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.resetZoom'
  | 'view.fullScreen'
  | 'agent.message'
  | 'agent.connect'
  | 'help.shortcuts'
  | 'help.guide'
  | 'help.docs'
  | 'help.reportBug'
  | 'help.copyDiagnostics'
  | 'help.openLogs'
  | 'help.privacy'
  | 'help.license'

/** Standard edit and window actions the platform performs itself. */
export type SystemRole =
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
  | 'quit' | 'hide' | 'hideOthers' | 'unhide' | 'services'
  | 'minimize' | 'zoom' | 'front' | 'close'
  | 'reload' | 'toggleDevTools'

export interface CommandSpec {
  id: CommandId
  label: string
  /** Electron accelerator syntax, e.g. "CmdOrCtrl+Shift+P". */
  accelerator?: string
  /** Only meaningful with a project open. */
  needsProject?: boolean
  /** Hidden from the command palette (it would only open itself). */
  paletteHidden?: boolean
}

export const COMMANDS: Record<CommandId, CommandSpec> = {
  'app.about': { id: 'app.about', label: 'About Axiom' },
  'app.settings': { id: 'app.settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,' },
  'app.checkUpdates': { id: 'app.checkUpdates', label: 'Check for Updates…' },
  'project.new': { id: 'project.new', label: 'New Project…', accelerator: 'CmdOrCtrl+N' },
  'project.open': { id: 'project.open', label: 'Open Folder…', accelerator: 'CmdOrCtrl+O' },
  'project.reveal': { id: 'project.reveal', label: 'Reveal Project Folder', needsProject: true },
  'project.settings': { id: 'project.settings', label: 'Project Settings…', needsProject: true },
  'project.reindex': { id: 'project.reindex', label: 'Re-index Project', needsProject: true },
  'project.close': { id: 'project.close', label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', needsProject: true },
  'view.commandPalette': { id: 'view.commandPalette', label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', paletteHidden: true },
  'view.search': { id: 'view.search', label: 'Search Files…', accelerator: 'CmdOrCtrl+K', needsProject: true },
  'view.fitView': { id: 'view.fitView', label: 'Fit Map to Window', accelerator: 'Shift+1', needsProject: true },
  'view.agentLog': { id: 'view.agentLog', label: 'Agent Log', accelerator: 'CmdOrCtrl+Shift+L', needsProject: true },
  'view.documents': { id: 'view.documents', label: 'Documents', accelerator: 'CmdOrCtrl+Shift+D', needsProject: true },
  'view.reviewChanges': { id: 'view.reviewChanges', label: 'Review Changes', needsProject: true },
  'view.zoomIn': { id: 'view.zoomIn', label: 'Zoom In Interface', accelerator: 'CmdOrCtrl+=' },
  'view.zoomOut': { id: 'view.zoomOut', label: 'Zoom Out Interface', accelerator: 'CmdOrCtrl+-' },
  'view.resetZoom': { id: 'view.resetZoom', label: 'Actual Size', accelerator: 'CmdOrCtrl+0' },
  'view.fullScreen': { id: 'view.fullScreen', label: 'Toggle Full Screen', accelerator: 'F11' },
  'agent.message': { id: 'agent.message', label: 'Message Agent…', accelerator: 'CmdOrCtrl+Enter', needsProject: true },
  'agent.connect': { id: 'agent.connect', label: 'Connect an Agent…', needsProject: true },
  'help.shortcuts': { id: 'help.shortcuts', label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/' },
  'help.guide': { id: 'help.guide', label: 'Setup Guide', needsProject: true },
  'help.docs': { id: 'help.docs', label: 'Documentation' },
  'help.reportBug': { id: 'help.reportBug', label: 'Report a Bug…' },
  'help.copyDiagnostics': { id: 'help.copyDiagnostics', label: 'Copy Diagnostics' },
  'help.openLogs': { id: 'help.openLogs', label: 'Open Logs Folder' },
  'help.privacy': { id: 'help.privacy', label: 'Privacy' },
  'help.license': { id: 'help.license', label: 'License' },
}

export type MenuEntry =
  | { kind: 'command'; id: CommandId }
  | { kind: 'role'; role: SystemRole; label: string; accelerator?: string }
  | { kind: 'separator' }

export interface MenuSection {
  id: 'app' | 'file' | 'edit' | 'view' | 'agent' | 'window' | 'help'
  label: string
  entries: MenuEntry[]
}

export type MenuPlatform = 'darwin' | 'win32' | 'linux'

const command = (id: CommandId): MenuEntry => ({ kind: 'command', id })
const role = (value: SystemRole, label: string, accelerator?: string): MenuEntry =>
  ({ kind: 'role', role: value, label, accelerator })
const separator: MenuEntry = { kind: 'separator' }

/**
 * The menu bar for one platform. macOS keeps app-level items (About,
 * Settings, Quit) in the application menu; Windows and Linux put them in
 * File and Help, where users of those systems look for them.
 */
export function buildMenu(platform: MenuPlatform, options: { developer?: boolean } = {}): MenuSection[] {
  const mac = platform === 'darwin'
  const sections: MenuSection[] = []

  if (mac) {
    sections.push({
      id: 'app', label: 'Axiom', entries: [
        command('app.about'), separator,
        command('app.settings'), command('app.checkUpdates'), separator,
        role('services', 'Services'), separator,
        role('hide', 'Hide Axiom', 'Cmd+H'), role('hideOthers', 'Hide Others', 'Cmd+Alt+H'), role('unhide', 'Show All'), separator,
        role('quit', 'Quit Axiom', 'Cmd+Q'),
      ],
    })
  }

  sections.push({
    id: 'file', label: 'File', entries: [
      command('project.new'), command('project.open'), separator,
      command('project.settings'), command('project.reindex'), command('project.reveal'), command('project.close'),
      ...(mac ? [] : [separator, command('app.settings'), separator, role('quit', 'Exit', 'Alt+F4')]),
    ],
  })

  sections.push({
    id: 'edit', label: 'Edit', entries: [
      role('undo', 'Undo', 'CmdOrCtrl+Z'), role('redo', 'Redo', mac ? 'Cmd+Shift+Z' : 'Ctrl+Y'), separator,
      role('cut', 'Cut', 'CmdOrCtrl+X'), role('copy', 'Copy', 'CmdOrCtrl+C'), role('paste', 'Paste', 'CmdOrCtrl+V'),
      role('selectAll', 'Select All', 'CmdOrCtrl+A'),
    ],
  })

  sections.push({
    id: 'view', label: 'View', entries: [
      command('view.commandPalette'), command('view.search'), separator,
      command('view.fitView'), command('view.reviewChanges'), separator,
      command('view.agentLog'), command('view.documents'), separator,
      command('view.zoomIn'), command('view.zoomOut'), command('view.resetZoom'), separator,
      command('view.fullScreen'),
      ...(options.developer
        ? [separator, role('reload', 'Reload Window', 'CmdOrCtrl+R'), role('toggleDevTools', 'Toggle Developer Tools', mac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I')]
        : []),
    ],
  })

  sections.push({
    id: 'agent', label: 'Agent', entries: [
      command('agent.message'), command('view.agentLog'), separator, command('agent.connect'),
    ],
  })

  if (mac) {
    sections.push({
      id: 'window', label: 'Window', entries: [
        role('minimize', 'Minimize', 'Cmd+M'), role('zoom', 'Zoom'), role('close', 'Close Window', 'Cmd+W'), separator,
        role('front', 'Bring All to Front'),
      ],
    })
  }

  sections.push({
    id: 'help', label: 'Help', entries: [
      command('help.shortcuts'), command('help.guide'), command('help.docs'), separator,
      command('help.reportBug'), command('help.copyDiagnostics'), command('help.openLogs'), separator,
      command('help.privacy'), command('help.license'),
      ...(mac ? [] : [separator, command('app.checkUpdates'), command('app.about')]),
    ],
  })

  return sections
}

// ─── Accelerators ───────────────────────────────────────────────────────────

export interface KeyEventLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

interface ParsedAccelerator {
  key: string
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

function parseAccelerator(accelerator: string, platform: MenuPlatform): ParsedAccelerator {
  const parts = accelerator.split('+')
  // "CmdOrCtrl+=" splits cleanly; "CmdOrCtrl++" would not, and is not used.
  const key = parts.pop() ?? ''
  const parsed: ParsedAccelerator = { key: key.toLowerCase(), meta: false, ctrl: false, shift: false, alt: false }
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case 'cmdorctrl':
      case 'commandorcontrol':
        if (platform === 'darwin') parsed.meta = true
        else parsed.ctrl = true
        break
      case 'cmd':
      case 'command':
        parsed.meta = true
        break
      case 'ctrl':
      case 'control':
        parsed.ctrl = true
        break
      case 'shift':
        parsed.shift = true
        break
      case 'alt':
      case 'option':
        parsed.alt = true
        break
    }
  }
  return parsed
}

/** Physical-key fallbacks for layouts where Shift changes the produced key. */
const DIGIT_CODES: Record<string, string> = {
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  '=': 'Equal', '-': 'Minus', '/': 'Slash', ',': 'Comma',
}

export function matchesAccelerator(event: KeyEventLike, accelerator: string, platform: MenuPlatform): boolean {
  const wanted = parseAccelerator(accelerator, platform)
  if (event.metaKey !== wanted.meta || event.ctrlKey !== wanted.ctrl || event.altKey !== wanted.alt) return false
  if (event.shiftKey !== wanted.shift) return false
  const key = event.key.toLowerCase()
  if (key === wanted.key) return true
  if (wanted.key === 'enter' && key === 'enter') return true
  const code = DIGIT_CODES[wanted.key]
  if (code && event.code === code) return true
  // "CmdOrCtrl+=" should also answer to the "+" users see on that key.
  if (wanted.key === '=' && key === '+') return true
  return false
}

/** The command a key press invokes, if any. */
export function commandForKey(event: KeyEventLike, platform: MenuPlatform): CommandId | null {
  for (const spec of Object.values(COMMANDS)) {
    if (spec.accelerator && matchesAccelerator(event, spec.accelerator, platform)) return spec.id
  }
  return null
}

/** How a shortcut is written for people: ⌘⇧P on macOS, Ctrl+Shift+P elsewhere. */
export function formatAccelerator(accelerator: string, platform: MenuPlatform): string {
  const parsed = parseAccelerator(accelerator, platform)
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key[0].toUpperCase() + parsed.key.slice(1)
  if (platform === 'darwin') {
    return `${parsed.ctrl ? '⌃' : ''}${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.meta ? '⌘' : ''}${key === 'Enter' ? '↩' : key}`
  }
  return [parsed.ctrl && 'Ctrl', parsed.alt && 'Alt', parsed.shift && 'Shift', parsed.meta && 'Win', key]
    .filter(Boolean).join('+')
}

/**
 * Commands for the palette, filtered by a query over their names. Names that
 * start with what was typed come first, then names with a word starting with
 * it, then any other match - so "set" finds Settings before "Reset".
 */
export function paletteCommands(query: string, projectOpen: boolean): CommandSpec[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const scored: Array<{ spec: CommandSpec; score: number; order: number }> = []
  Object.values(COMMANDS).forEach((spec, order) => {
    if (spec.paletteHidden || (spec.needsProject && !projectOpen)) return
    const label = spec.label.toLowerCase()
    const labelWords = label.split(/[^a-z0-9]+/).filter(Boolean)
    let score = 0
    for (const word of words) {
      if (label.startsWith(word)) continue
      if (labelWords.some(labelWord => labelWord.startsWith(word))) { score += 1; continue }
      if (label.includes(word)) { score += 2; continue }
      return
    }
    scored.push({ spec, score, order })
  })
  return scored.sort((left, right) => left.score - right.score || left.order - right.order).map(entry => entry.spec)
}
