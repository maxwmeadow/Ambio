import fs from 'fs'
import { basename, join, relative } from 'path'
import { classifyProjectFile, isAlwaysSkippedDir } from '../src/shared/fileKinds.ts'

// A quick count of what indexing a folder would read, so a project that is
// far bigger than intended is caught on the setup screen instead of after ten
// minutes of indexing. It mirrors archd's own skips (skipDirs, dot folders,
// the user's exclusions) and stops early on truly huge trees.

/** Folder counts are kept this many levels below the project root. */
const FOLDER_COUNT_DEPTH = 4

export interface ScopeEstimate {
  sourceFiles: number
  /** Readable documents (Markdown and text), kept in the library, not on the map. */
  documents: number
  /** Source files under each folder, by absolute path, for the first few levels. */
  folders: Record<string, number>
  /** The walk stopped at its limits; the real number is higher. */
  truncated: boolean
  /** Top-level folders holding the most source files. */
  largest: Array<{ path: string; name: string; sourceFiles: number }>
  /**
   * Default-skipped folders (venv, bin, coverage, ...) found at any depth and
   * left out, when the estimate was asked to apply those defaults. A new
   * project saves them as exclusions.
   */
  skippedFolders: string[]
}

/**
 * What a generated folder holds, by its usual name. A name alone is not
 * enough below the top level: src/components/coverage is often a feature.
 */
const GENERATED_MARKERS: Record<string, string[]> = {
  coverage: ['lcov.info', 'coverage-final.json', 'clover.xml', 'lcov-report'],
  obj: ['project.assets.json'],
  bin: ['Debug', 'Release'],
  Library: ['PackageCache', 'ArtifactDB'],
}

/** A folder tools made: a Python virtualenv by any name, or a marked one. */
function isGeneratedFolder(name: string, entries: fs.Dirent[]): boolean {
  const names = new Set(entries.map(entry => entry.name))
  if (names.has('pyvenv.cfg')) return true
  return (GENERATED_MARKERS[name] ?? []).some(marker => names.has(marker))
}

function excludedSet(ignored: readonly string[]): Set<string> {
  return new Set(ignored.map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)))
}

/**
 * With `included` (a new project's setup), default-skipped folders are left
 * out wherever they are, except the ones listed; without it, only `ignored`
 * and archd's own skips apply, as for a project already set up.
 */
export function estimateScope(
  rootPath: string,
  ignored: readonly string[],
  limits: { maxEntries?: number; maxMillis?: number } = {},
  included?: readonly string[],
): ScopeEstimate {
  const maxEntries = limits.maxEntries ?? 250_000
  const deadline = Date.now() + (limits.maxMillis ?? 3000)
  const excluded = excludedSet(ignored)
  const kept = new Set(included ?? [])
  const skippedFolders: string[] = []
  const perTop = new Map<string, number>()
  const folders: Record<string, number> = {}
  let sourceFiles = 0
  let documents = 0
  let visited = 0
  let truncated = false
  const stack: string[] = [rootPath]

  while (stack.length > 0) {
    if (visited >= maxEntries || Date.now() > deadline) { truncated = true; break }
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    if (included && dir !== rootPath && !kept.has(dir) && isGeneratedFolder(basename(dir), entries)) {
      skippedFolders.push(dir)
      continue
    }
    for (const entry of entries) {
      visited++
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isAlwaysSkippedDir(entry.name) || excluded.has(path)) continue
        stack.push(path)
        continue
      }
      if (!entry.isFile() || excluded.has(path)) continue
      const kind = classifyProjectFile(entry.name)
      if (kind === 'document') documents++
      if (kind !== 'source' || entry.name.toLowerCase().includes('.min.')) continue
      sourceFiles++
      const parts = relative(rootPath, path).split(/[\\/]/)
      const top = parts[0]
      if (top !== entry.name) perTop.set(top, (perTop.get(top) ?? 0) + 1)
      let folder = rootPath
      for (const part of parts.slice(0, Math.min(parts.length - 1, FOLDER_COUNT_DEPTH))) {
        folder = join(folder, part)
        folders[folder] = (folders[folder] ?? 0) + 1
      }
    }
  }

  const largest = [...perTop.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, path: join(rootPath, name), sourceFiles: count }))
  return { sourceFiles, documents, folders, truncated, largest, skippedFolders: skippedFolders.sort() }
}
