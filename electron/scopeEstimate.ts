import fs from 'fs'
import { join, relative } from 'path'
import { classifyProjectFile } from '../src/shared/fileKinds.ts'

// A quick count of what indexing a folder would read, so a project that is
// far bigger than intended is caught on the setup screen instead of after ten
// minutes of indexing. It mirrors archd's own skips (skipDirs, dot folders,
// the user's exclusions) and stops early on truly huge trees.

const ARCHD_SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode', 'dist', 'build', 'out', '.next', '__pycache__', 'vendor', 'target'])

export interface ScopeEstimate {
  sourceFiles: number
  /** The walk stopped at its limits; the real number is higher. */
  truncated: boolean
  /** Top-level folders holding the most source files. */
  largest: Array<{ path: string; name: string; sourceFiles: number }>
}

function excludedSet(ignored: readonly string[]): Set<string> {
  return new Set(ignored.map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)))
}

export function estimateScope(
  rootPath: string,
  ignored: readonly string[],
  limits: { maxEntries?: number; maxMillis?: number } = {},
): ScopeEstimate {
  const maxEntries = limits.maxEntries ?? 250_000
  const deadline = Date.now() + (limits.maxMillis ?? 3000)
  const excluded = excludedSet(ignored)
  const perTop = new Map<string, number>()
  let sourceFiles = 0
  let visited = 0
  let truncated = false
  const stack: string[] = [rootPath]

  while (stack.length > 0) {
    if (visited >= maxEntries || Date.now() > deadline) { truncated = true; break }
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      visited++
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ARCHD_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || excluded.has(path)) continue
        stack.push(path)
        continue
      }
      if (!entry.isFile() || excluded.has(path)) continue
      if (classifyProjectFile(entry.name) !== 'source' || entry.name.toLowerCase().includes('.min.')) continue
      sourceFiles++
      const top = relative(rootPath, path).split(/[\\/]/)[0]
      if (top !== entry.name) perTop.set(top, (perTop.get(top) ?? 0) + 1)
    }
  }

  const largest = [...perTop.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, path: join(rootPath, name), sourceFiles: count }))
  return { sourceFiles, truncated, largest }
}
