import { randomUUID } from 'crypto'
import fs from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import type { ProjectConfig } from '../src/shared/types'

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
}: RemoveProjectDataOptions): Promise<void> {
  const projectDataDir = validatedProjectDataDir(dataDir, projectId)
  let daemonUnavailable = false
  try {
    const response = await request(
      `http://127.0.0.1:${apiPort}/api/workspace/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Axiom could not delete the project data (${response.status})${detail ? `: ${detail}` : '.'}`)
    }
  } catch (error) {
    // HTTP responses are authoritative failures. Connection failures mean the
    // daemon is down, so there can be no daemon-owned SQLite lock to release.
    if (error instanceof Error && error.message.startsWith('Axiom could not delete')) throw error
    daemonUnavailable = true
  }

  // Current archd deletes the directory itself. This also supports users whose
  // running daemon predates that contract and only closed its connection.
  if (daemonUnavailable || fs.existsSync(projectDataDir)) {
    fs.rmSync(projectDataDir, { recursive: true, force: true })
  }
  if (fs.existsSync(projectDataDir)) {
    throw new Error('Axiom could not verify that the project data was deleted.')
  }
  clearActiveProjectPointer(dataDir, projectId)
}
