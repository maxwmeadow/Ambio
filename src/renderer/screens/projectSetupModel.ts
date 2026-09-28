import { classifyProjectFile, type ProjectFileKind } from '../../shared/fileKinds.ts'

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

export const COMMON_NOISE = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.env',
  'coverage', '.nyc_output',
  'vendor', 'target',
  '.idea', '.vscode', '.vs',
  'Library', 'Temp', 'Logs', 'UserSettings', 'obj',
  '.gradle', '.mvn', 'bin', '.cache',
])

export function shouldAutoExclude(name: string): boolean {
  return COMMON_NOISE.has(name) || name.startsWith('.')
}

export function makeTreeNode(entry: DirEntry): TreeNode {
  const kind = classifyProjectFile(entry.name, entry.isDirectory)
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    kind,
    excluded: shouldAutoExclude(entry.name) || kind === 'unsupported',
    expanded: false,
  }
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
      // Unsupported files are rejected by Axiom's global file policy. They are
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

export interface ExploredScopeCounts {
  folders: number
  files: number
  documents: number
  unsupported: number
  totalExplored: number
  excludedCount: number
}

/**
 * Counts kinds discovered in the lazily loaded tree.
 * NOTE: These are strictly counts of explored nodes in the tree, NOT an
 * exhaustive census of the repository on disk.
 */
export function countExploredKinds(nodes: TreeNode[]): ExploredScopeCounts {
  const result: ExploredScopeCounts = {
    folders: 0,
    files: 0,
    documents: 0,
    unsupported: 0,
    totalExplored: 0,
    excludedCount: 0,
  }
  const visit = (branch: TreeNode[]) => {
    for (const node of branch) {
      result.totalExplored += 1
      if (node.excluded) {
        result.excludedCount += 1
      }
      if (node.kind === 'unsupported') {
        result.unsupported += 1
        continue
      }
      if (node.excluded) continue
      if (node.kind === 'folder') result.folders += 1
      else if (node.kind === 'document') result.documents += 1
      else if (node.kind === 'source') result.files += 1
      if (node.children) visit(node.children)
    }
  }
  visit(nodes)
  return result
}

export function formatExploredScopeSummary(counts: ExploredScopeCounts): {
  headline: string
  subtext: string
} {
  const sourcePart = `${counts.files} source ${counts.files === 1 ? 'file' : 'files'}`
  const docPart = `${counts.documents} ${counts.documents === 1 ? 'document' : 'documents'}`
  const folderPart = `${counts.folders} ${counts.folders === 1 ? 'folder' : 'folders'}`

  const headline = `${sourcePart} and ${docPart} discovered in this preview`
  const subtext = `${folderPart} shown. Counts cover loaded folders, not all files on disk; indexing scans included folders recursively.`

  return { headline, subtext }
}
