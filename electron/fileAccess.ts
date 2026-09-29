import fs from 'fs'
import { delimiter, extname, join, relative, resolve, sep, isAbsolute } from 'path'

// What the renderer may ask the main process to do with files on disk.
//
// "Open" is the dangerous one: the OS default handler for a file can be an
// interpreter. On Windows, double-clicking a .js file runs it under Windows
// Script Host; elsewhere a script with the right association can run too. So
// source files open in the user's code editor, and only plain documents are
// ever handed to the system's default application.

export interface Editor { id: string; label: string; command: string }

/** Documents that no platform associates with an interpreter. */
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc'])

export function safeForSystemOpen(file: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(file).toLowerCase())
}

/** True when `target` is inside one of `roots` (or is one of them). */
export function isInside(target: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  if (!isAbsolute(target)) return false
  const fold = (value: string) => (platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value)
  const resolvedTarget = fold(resolve(target))
  return roots.some(root => {
    const rel = relative(fold(resolve(root)), resolvedTarget)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
  })
}

interface EditorCandidate { id: string; label: string; cli: string[]; paths: (env: NodeJS.ProcessEnv, home: string) => string[] }

const CANDIDATES: EditorCandidate[] = [
  {
    id: 'vscode', label: 'Visual Studio Code', cli: ['code'],
    paths: (env, home) => [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      join(home, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
      join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe'),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    ],
  },
  {
    id: 'cursor', label: 'Cursor', cli: ['cursor'],
    paths: (env, home) => [
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'cursor', 'Cursor.exe'),
    ],
  },
  {
    id: 'windsurf', label: 'Windsurf', cli: ['windsurf'],
    paths: (env, home) => [
      '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
      join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'Windsurf', 'Windsurf.exe'),
    ],
  },
  { id: 'zed', label: 'Zed', cli: ['zed', 'zeditor'], paths: () => ['/Applications/Zed.app/Contents/MacOS/cli'] },
  { id: 'sublime', label: 'Sublime Text', cli: ['subl'], paths: () => ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'] },
  { id: 'intellij', label: 'IntelliJ IDEA', cli: ['idea'], paths: () => [] },
  { id: 'webstorm', label: 'WebStorm', cli: ['webstorm'], paths: () => [] },
  { id: 'pycharm', label: 'PyCharm', cli: ['pycharm'], paths: () => [] },
  { id: 'goland', label: 'GoLand', cli: ['goland'], paths: () => [] },
]

function onPath(names: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  // A GUI app on macOS inherits a minimal PATH, so the usual CLI homes are
  // checked too. Windows CLI shims are .cmd files, which cannot be spawned
  // without a shell; Windows uses the executable paths above instead.
  if (platform === 'win32') return null
  const dirs = [...(env.PATH ?? '').split(delimiter), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/snap/bin']
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* not here */ }
    }
  }
  return null
}

export function detectEditors(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = env.HOME ?? env.USERPROFILE ?? '',
): Editor[] {
  const found: Editor[] = []
  for (const candidate of CANDIDATES) {
    const command = onPath(candidate.cli, env, platform)
      ?? candidate.paths(env, home).find(path => { try { return fs.statSync(path).isFile() } catch { return false } })
    if (command) found.push({ id: candidate.id, label: candidate.label, command })
  }
  return found
}

/** The editor to use for a setting of 'auto' or an editor id. */
export function chooseEditor(setting: string, editors: Editor[]): Editor | null {
  if (setting === 'auto') return editors[0] ?? null
  return editors.find(editor => editor.id === setting) ?? null
}
