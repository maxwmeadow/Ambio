import { randomUUID } from 'crypto'
import fs from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import type { ProjectConfig, TrashedProject } from '../src/shared/types'

export function readResumeProjectId(settingsFile: string): string | null {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { resumeProjectId?: unknown }
    return typeof settings.resumeProjectId === 'string' ? settings.resumeProjectId : null
  } catch { return null }
}

export function writeResumeProjectId(settingsFile: string, projectId: string | null): void {
  fs.mkdirSync(dirname(settingsFile), { recursive: true })
  let previous: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed as Record<string, unknown>
  } catch { /* a missing or malformed settings file starts fresh */ }
  const temp = `${settingsFile}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ ...previous, resumeProjectId: projectId }, null, 2))
  fs.renameSync(temp, settingsFile)
}

/** A database on disk proves an older project already entered the workbench. */
export function migrateIndexedProjectLifecycle(config: ProjectConfig, dataDir: string): ProjectConfig {
  if (config.workbenchOpenedAt || config.reviewCompletedAt) return config
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.id) || config.id === '.' || config.id === '..') return config
  if (!fs.existsSync(join(dataDir, config.id, 'axiom.db'))) return config
  return { ...config, workbenchOpenedAt: config.openedAt || Date.now() }
}

export function sameProjectRoot(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

export function findProjectByRoot(
  projects: readonly ProjectConfig[],
  rootPath: string,
): ProjectConfig | undefined {
  return projects.find(project => sameProjectRoot(project.rootPath, rootPath))
}

/** A project id names one lifetime, not one filesystem path forever. */
export function createProjectId(): string {
  return randomUUID()
}

/**
 * Refresh the part of project setup state that the filesystem owns. Keeping
 * this on the persisted project record lets the renderer distinguish a blank
 * project created by Axiom from a codebase opened through the launcher, while
 * still switching to the codebase journey as soon as files appear.
 */
export function refreshProjectDiskState(config: ProjectConfig): ProjectConfig {
  let rootIsEmpty = false
  let rootMissing = false
  try {
    const isDirectory = fs.statSync(config.rootPath).isDirectory()
    rootMissing = !isDirectory
    rootIsEmpty = isDirectory && fs.readdirSync(config.rootPath).length === 0
  } catch (error) {
    // A missing folder is not an empty blank project. An unreadable one
    // (permissions) still exists, so it is not reported as moved.
    rootMissing = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
      (error as NodeJS.ErrnoException)?.code === 'ENOTDIR'
  }
  return { ...config, rootIsEmpty, rootMissing }
}

/** Rebase one absolute path from under oldRoot to under newRoot. */
export function rebasePath(path: string, oldRoot: string, newRoot: string): string {
  // Compared in slash form so either separator style matches; the suffix is
  // kept verbatim because exclusion globs mix "\\" and "/**" on Windows.
  const slash = (value: string) => value.replace(/\\/g, '/')
  const oldSlash = slash(oldRoot).replace(/\/+$/, '')
  const pathSlash = slash(path)
  if (pathSlash === oldSlash) return newRoot
  if (!pathSlash.startsWith(`${oldSlash}/`)) return path
  return `${newRoot.replace(/[\\/]+$/, '')}${path.slice(oldSlash.length)}`
}

/**
 * The same project, now living at newRoot. Identity, lifecycle milestones and
 * exclusions carry over, so a moved folder reopens straight into its map.
 */
export function relocateProjectConfig(config: ProjectConfig, newRoot: string): ProjectConfig {
  return {
    ...config,
    rootPath: newRoot,
    ignoredPaths: config.ignoredPaths.map(pattern => rebasePath(pattern, config.rootPath, newRoot)),
    rootMissing: false,
  }
}

function validatedProjectDataDir(dataDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new Error('Invalid project id.')
  }
  const base = resolve(dataDir)
  const target = resolve(base, projectId)
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || dirname(target) !== base) {
    throw new Error('Project data path escapes Axiom\'s data directory.')
  }
  return target
}

function clearActiveProjectPointer(dataDir: string, projectId: string): void {
  const activePath = join(dataDir, 'active_project.json')
  if (!fs.existsSync(activePath)) return
  try {
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8')) as { workspaceId?: string }
    if (active.workspaceId === projectId) fs.rmSync(activePath, { force: true })
  } catch {
    // A malformed pointer is not safe to retain after deleting its project.
    fs.rmSync(activePath, { force: true })
  }
}

export interface RemoveProjectDataOptions {
  projectId: string
  dataDir: string
  apiPort: number
  request?: typeof fetch
  /** Move the map to data/.trash instead of deleting it. */
  trash?: boolean
}

export const TRASH_DIR = '.trash'
export const TRASH_DAYS = 30

export type TrashEntry = TrashedProject

/** Maps in the trash, newest first; entries without metadata are skipped. */
export function listTrash(dataDir: string): TrashEntry[] {
  const root = join(dataDir, TRASH_DIR)
  let names: string[] = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const entries: TrashEntry[] = []
  for (const trashId of names) {
    const meta = readTrashMeta(join(root, trashId))
    if (!meta) continue
    entries.push({ trashId, config: meta.config, deletedAt: meta.deletedAt, expiresAt: meta.deletedAt + TRASH_DAYS * 86_400_000 })
  }
  return entries.sort((left, right) => right.deletedAt - left.deletedAt)
}

/**
 * What a trashed map was. A map whose trash.json was never written (the app
 * quit between the move and the write) is still listed, by the project ID
 * and time in its folder name, `<id>-<ms>`; restoring it brings the map back
 * with no folder, which the launcher offers to locate.
 */
function readTrashMeta(entryPath: string): { config: ProjectConfig; deletedAt: number } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(join(entryPath, 'trash.json'), 'utf8')) as { config: ProjectConfig; deletedAt: number }
    return meta?.config?.id && typeof meta.deletedAt === 'number' ? meta : null
  } catch {
    const orphan = /^(.+)-(\d{13})$/.exec(basename(entryPath))
    if (!orphan || !/^[A-Za-z0-9._-]{1,200}$/.test(orphan[1]) || orphan[1].startsWith('.')) return null
    try { if (!fs.statSync(entryPath).isDirectory()) return null } catch { return null }
    return {
      config: {
        id: orphan[1], name: `Unlabeled map ${orphan[1].slice(0, 8)}`, rootPath: '', ignoredPaths: [],
        languageOverrides: {}, layoutPreferences: { zoom: 1, panX: 0, panY: 0 }, openedAt: Number(orphan[2]),
      },
      deletedAt: Number(orphan[2]),
    }
  }
}

export function trashEntryPath(dataDir: string, trashId: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(trashId) || trashId.startsWith('.')) throw new Error('Invalid trash entry.')
  return join(dataDir, TRASH_DIR, trashId)
}

/** Put a trashed map back. Fails if the project already has a map again. */
export function restoreTrash(dataDir: string, trashId: string): ProjectConfig {
  const source = trashEntryPath(dataDir, trashId)
  const meta = readTrashMeta(source)
  if (!meta) throw new Error('That map is no longer in Recently Deleted.')
  const target = validatedProjectDataDir(dataDir, meta.config.id)
  if (fs.existsSync(target)) throw new Error(`"${meta.config.name}" already has a map. Delete it before restoring this one.`)
  fs.rmSync(join(source, 'trash.json'), { force: true })
  fs.renameSync(source, target)
  return meta.config
}

/** Record what a trashed map was so the launcher can list and restore it. */
export function writeTrashMeta(trashPath: string, config: ProjectConfig, deletedAt = Date.now()): void {
  fs.writeFileSync(join(trashPath, 'trash.json'), JSON.stringify({ config, deletedAt }, null, 2))
}

/**
 * Delete trash entries older than TRASH_DAYS. Entries without metadata (the
 * app quit between the move and writing trash.json) age by the time in their
 * name, `<id>-<ms>`, which archd and the local fallback both write; anything
 * else is left alone. Returns how many went.
 */
export function purgeExpiredTrash(dataDir: string, now = Date.now()): number {
  const root = join(dataDir, TRASH_DIR)
  let names: string[] = []
  try { names = fs.readdirSync(root) } catch { return 0 }
  const listed = new Map(listTrash(dataDir).map(entry => [entry.trashId, entry.expiresAt]))
  const cutoff = TRASH_DAYS * 86_400_000
  let purged = 0
  for (const name of names) {
    let expiresAt = listed.get(name)
    if (expiresAt === undefined) {
      const stamp = /-(\d{13})$/.exec(name)
      if (!stamp) continue
      expiresAt = Number(stamp[1]) + cutoff
    }
    if (expiresAt > now) continue
    try {
      fs.rmSync(trashEntryPath(dataDir, name), { recursive: true, force: true })
      purged++
    } catch { /* not a name we write */ }
  }
  return purged
}

/**
 * Permanently removes one project lifetime. The daemon is authoritative while
 * running because it owns SQLite and watcher locks; a local fallback covers a
 * stopped daemon and older daemon builds. Success is reported only after the
 * directory is verified absent.
 */
export async function removeProjectData({
  projectId,
  dataDir,
  apiPort,
  request = fetch,
  trash = false,
}: RemoveProjectDataOptions): Promise<string | null> {
  const projectDataDir = validatedProjectDataDir(dataDir, projectId)
  let daemonUnavailable = false
  let trashPath: string | null = null
  try {
    const response = await request(
      `http://127.0.0.1:${apiPort}/api/workspace/${encodeURIComponent(projectId)}${trash ? '?trash=1' : ''}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Axiom could not delete the project data (${response.status})${detail ? `: ${detail}` : '.'}`)
    }
    if (trash) {
      // archd moved the folder into the trash and reports where.
      const body = await response.json().catch(() => null) as { trashPath?: unknown } | null
      if (typeof body?.trashPath === 'string' && body.trashPath) trashPath = body.trashPath
    }
  } catch (error) {
    // HTTP responses are authoritative failures. Connection failures mean the
    // daemon is down, so there can be no daemon-owned SQLite lock to release.
    if (error instanceof Error && error.message.startsWith('Axiom could not delete')) throw error
    daemonUnavailable = true
  }

  // Current archd deletes (or trashes) the directory itself. This also covers
  // a stopped daemon, and one that predates that contract.
  if (daemonUnavailable || fs.existsSync(projectDataDir)) {
    if (trash && fs.existsSync(projectDataDir)) {
      fs.mkdirSync(join(dataDir, TRASH_DIR), { recursive: true })
      trashPath = join(dataDir, TRASH_DIR, `${projectId}-${Date.now()}`)
      fs.renameSync(projectDataDir, trashPath)
    } else {
      fs.rmSync(projectDataDir, { recursive: true, force: true })
    }
  }
  if (fs.existsSync(projectDataDir)) {
    throw new Error('Axiom could not verify that the project data was deleted.')
  }
  clearActiveProjectPointer(dataDir, projectId)
  return trashPath
}

/** What an exported .axiommap carries besides the map itself. */
export function exportManifest(config: ProjectConfig, appVersion: string): Record<string, string> {
  const { id: _id, rootMissing: _missing, hiddenFromRecents: _hidden, ...portable } = config
  return { name: config.name, rootPath: config.rootPath, appVersion, config: JSON.stringify(portable) }
}

/**
 * The registry entry for an imported map. It keeps the exported project's id
 * (the map's rows carry it) and settings, pointed at wherever the code lives
 * on this computer.
 */
export function importedProjectConfig(manifest: Record<string, string>, rootPath: string, now = Date.now()): ProjectConfig {
  let saved: Partial<ProjectConfig> = {}
  try {
    const parsed = JSON.parse(manifest.config ?? '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Partial<ProjectConfig>
  } catch { /* an older or hand-made file: defaults below */ }
  const exportedRoot = typeof manifest.rootPath === 'string' && manifest.rootPath ? manifest.rootPath : rootPath
  const base: ProjectConfig = {
    languageOverrides: {},
    layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
    ...saved,
    id: manifest.workspaceId,
    name: manifest.name || saved.name || rootPath.split(/[/\\]/).pop() || 'Project',
    rootPath: exportedRoot,
    ignoredPaths: Array.isArray(saved.ignoredPaths) ? saved.ignoredPaths.filter(path => typeof path === 'string') : [],
    openedAt: now,
    hiddenFromRecents: false,
  }
  // The map was indexed before it was exported, so it opens straight to the workbench.
  if (!base.workbenchOpenedAt) base.workbenchOpenedAt = now
  return sameProjectRoot(exportedRoot, rootPath) ? { ...base, rootMissing: false } : relocateProjectConfig(base, rootPath)
}
