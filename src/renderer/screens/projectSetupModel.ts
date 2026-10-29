import { classifyProjectFile, DEFAULT_SKIPPED_DIRS, isAlwaysSkippedDir, isDefaultSkippedDir, type ProjectFileKind } from '../../shared/fileKinds.ts'

export interface DirEntry {
  name: string
  isDirectory: boolean
  path: string
}

export interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  kind: ProjectFileKind
  children?: TreeNode[]
  excluded: boolean
  expanded: boolean
}

export const COMMON_NOISE = DEFAULT_SKIPPED_DIRS

export const shouldAutoExclude = isDefaultSkippedDir

/**
 * Every folder shown checked in the tree. What the person sees checked is
 * read; below that, setup also leaves out folders tools generated (a
 * virtualenv, a coverage report) that were never opened here.
 */
export function collectCheckedFolders(nodes: TreeNode[]): string[] {
  const result: string[] = []
  const visit = (branch: TreeNode[]) => {
    for (const node of branch) {
      if (!node.isDirectory || node.excluded) continue
      result.push(node.path)
      if (node.children) visit(node.children)
    }
  }
  visit(nodes)
  return result
}

/**
 * A tree row. With `existing` (a project's saved exclusions), the row shows
 * what the user chose before; without it, first-run defaults apply.
 */
export function makeTreeNode(entry: DirEntry, existing?: ReadonlySet<string>): TreeNode {
  const kind = classifyProjectFile(entry.name, entry.isDirectory)
  const chosen = existing
    ? existing.has(`${entry.path}/**`) || existing.has(entry.path)
    : shouldAutoExclude(entry.name)
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    kind,
    excluded: chosen || kind === 'unsupported',
    expanded: false,
  }
}

/**
 * Exclusions after editing. The tree only holds folders the user expanded, so
 * an earlier exclusion deeper than that is not in the tree - it must survive
 * the edit rather than silently vanish.
 */
export function mergeExclusions(nodes: TreeNode[], previous: readonly string[]): string[] {
  const edited = collectExcluded(nodes)
  const kept = previous.filter(pattern => {
    const path = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    return !findNode(nodes, path)
  })
  return [...new Set([...edited, ...kept])]
}

export function foldersFirst(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    const leftExcluded = shouldAutoExclude(left.name)
    const rightExcluded = shouldAutoExclude(right.name)
    if (leftExcluded !== rightExcluded) return leftExcluded ? 1 : -1
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
}

export function findNode(nodes: TreeNode[], targetPath: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.children) {
      const found = findNode(node.children, targetPath)
      if (found) return found
    }
  }
  return undefined
}

export function toggleNode(nodes: TreeNode[], targetPath: string, field: 'excluded' | 'expanded'): TreeNode[] {
  return nodes.map(node => {
    if (node.path === targetPath) return { ...node, [field]: !node[field] }
    if (node.children) return { ...node, children: toggleNode(node.children, targetPath, field) }
    return node
  })
}

export function setChildren(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.path === targetPath) return { ...node, children }
    if (node.children) return { ...node, children: setChildren(node.children, targetPath, children) }
    return node
  })
}

export function collectExcluded(nodes: TreeNode[]): string[] {
  const result: string[] = []
  const visit = (branch: TreeNode[]) => {
    for (const node of branch) {
      // Unsupported files are rejected by Ambio's global file policy. They are
      // not project-specific ignore choices and must not bloat ignoredPaths.
      if (node.kind === 'unsupported') continue
      if (node.excluded) {
        result.push(node.isDirectory ? `${node.path}/**` : node.path)
      } else if (node.children) {
        visit(node.children)
      }
    }
  }
  visit(nodes)
  return result
}

/**
 * A row nobody can include: a file type Ambio does not read, or a folder the
 * indexer never enters. It is shown for orientation, without a checkbox.
 */
export function isNeverRead(node: TreeNode): boolean {
  return node.kind === 'unsupported' || (node.isDirectory && isAlwaysSkippedDir(node.name))
}

/**
 * Rows worth a decision, and the rest. Tucked away are the rows that can
 * never be read and the noise folders still skipped by default; including a
 * noise folder moves it up among the choices.
 */
export function splitSetupRows(nodes: TreeNode[]): { shown: TreeNode[]; tucked: TreeNode[] } {
  const shown: TreeNode[] = []
  const tucked: TreeNode[] = []
  for (const node of nodes) {
    const noise = node.isDirectory && node.excluded && shouldAutoExclude(node.name)
    if (isNeverRead(node) || noise) tucked.push(node)
    else shown.push(node)
  }
  return { shown, tucked }
}

/** "5 skipped automatically: .git, .venv, node_modules and 2 more" */
export function tuckedSummary(tucked: TreeNode[]): string {
  const names = tucked.slice(0, 3).map(node => node.name)
  const rest = tucked.length - names.length
  return `${tucked.length} skipped automatically: ${names.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
}

/** What pressing Index will read, from a real count of the checked scope. */
export function scopeHeadline(estimate: { sourceFiles: number; truncated: boolean } | null): string {
  if (!estimate) return 'Counting source files…'
  if (estimate.sourceFiles === 0 && !estimate.truncated) return 'No source files in what is checked'
  const files = `${estimate.sourceFiles.toLocaleString('en-US')} source ${estimate.sourceFiles === 1 ? 'file' : 'files'}`
  return `${estimate.truncated ? 'More than ' : ''}${files} will be read`
}

const NOISE_KINDS: Record<string, string> = {
  venv: 'a Python virtual environment: installed packages, not your code',
  coverage: 'test coverage reports',
  bin: 'build output',
  obj: 'build output',
  Library: 'files Unity generates',
  Temp: 'temporary files',
  Logs: 'log files',
  UserSettings: 'editor settings',
}

/**
 * A warning for a folder that is skipped by default and has been checked. It
 * is the user's call, but they should make it knowing what the folder usually
 * holds and how much it adds.
 */
export function noiseFolderWarning(node: TreeNode, sourceFiles?: number): string | null {
  if (!node.isDirectory || node.excluded || isNeverRead(node) || !shouldAutoExclude(node.name)) return null
  const what = NOISE_KINDS[node.name] ?? 'generated or third-party files'
  const size = sourceFiles === undefined ? ''
    : sourceFiles === 0 ? ' It holds no source files Ambio reads.'
      : ` It adds ${sourceFiles.toLocaleString('en-US')} source ${sourceFiles === 1 ? 'file' : 'files'} to the map.`
  return `${node.name} is usually ${what}.${size} Uncheck it unless you wrote what is inside.`
}
