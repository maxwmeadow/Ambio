import fs from 'fs'
import { join, relative } from 'path'
import { classifyProjectFile, isAlwaysSkippedDir } from '../src/shared/fileKinds.ts'
import { folderSkipReason, hasGeneratedHeader, isGitIgnored, projectContext } from './scopeDefaults.ts'

// A quick count of what indexing a folder would read, so a project that is
// far bigger than intended is caught on the setup screen instead of after ten
// minutes of indexing. It mirrors archd's own skips (skipDirs, dot folders,
// generated-file headers, the user's exclusions) and stops early on truly
// huge trees.

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
   * Folders and files left out by setup's defaults below what the tree shows
   * (a virtualenv, a .gitignore entry, a copy of a repository), when the
   * estimate was asked to apply them. A new project saves them as exclusions.
   */
  skippedFolders: string[]
  skippedFiles: string[]
  /** Source files archd skips for their generator's header. */
  generatedFiles: number
}

function excludedSet(ignored: readonly string[]): Set<string> {
  return new Set(ignored.map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)))
}

/**
 * With `included` (a new project's setup: every path shown checked), setup's
 * defaults apply to everything else (scopeDefaults.ts); without it, only
 * `ignored` and archd's own skips apply, as for a project already set up.
 */
export function estimateScope(
  rootPath: string,
  ignored: readonly string[],
  limits: { maxEntries?: number; maxMillis?: number } = {},
  included?: readonly string[],
): ScopeEstimate {
  const maxEntries = limits.maxEntries ?? 250_000
  const excluded = excludedSet(ignored)
  const kept = new Set(included ?? [])
  // Reading the repositories (a few git calls each) is cached between
  // recounts, so it does not come out of the walk's time.
  const context = included ? projectContext(rootPath) : null
  const deadline = Date.now() + (limits.maxMillis ?? 3000)
  const skippedFolders: string[] = []
  const skippedFiles: string[] = []
  const perTop = new Map<string, number>()
  const folders: Record<string, number> = {}
  let sourceFiles = 0
  let documents = 0
  let generatedFiles = 0
  let visited = 0
  let truncated = false
  const stack: string[] = [rootPath]

  while (stack.length > 0) {
    if (visited >= maxEntries || Date.now() > deadline) { truncated = true; break }
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    if (context && dir !== rootPath && !kept.has(dir) && folderSkipReason(context, dir, entries)) {
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
      if (context && !kept.has(path) && isGitIgnored(context, path)) {
        skippedFiles.push(path)
        continue
      }
      if (hasGeneratedHeader(path)) {
        generatedFiles++
        continue
      }
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
  return {
    sourceFiles, documents, folders, truncated, largest, generatedFiles,
    skippedFolders: skippedFolders.sort(), skippedFiles: skippedFiles.sort(),
  }
}
