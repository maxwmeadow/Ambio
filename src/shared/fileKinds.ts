export type ProjectFileKind = 'folder' | 'source' | 'document' | 'unsupported'

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.py', '.go', '.rs', '.cs',
  '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.c', '.h',
  '.rb', '.java',
  '.css', '.scss', '.sass', '.less',
  '.hh', '.c++', '.kt', '.kts', '.swift', '.php',
  '.scala', '.sc', '.groovy', '.lua', '.sh', '.bash', '.ex', '.exs',
])

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc'])

/**
 * Folders the indexer never enters, whatever a project's settings say
 * (archd's skipDirs, internal/indexer/indexer.go). Folders whose name starts
 * with a dot are skipped the same way.
 */
const ALWAYS_SKIPPED_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode', 'dist', 'build', 'out', '.next', '__pycache__', 'vendor', 'target'])

export function isAlwaysSkippedDir(name: string): boolean {
  return ALWAYS_SKIPPED_DIRS.has(name) || name.startsWith('.')
}

function extensionOf(path: string): string {
  const basenameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  const dot = path.lastIndexOf('.')
  return dot > basenameStart ? path.slice(dot).toLowerCase() : ''
}

export function classifyProjectFile(path: string, isDirectory = false): ProjectFileKind {
  if (isDirectory) return 'folder'
  const extension = extensionOf(path)
  if (SOURCE_EXTENSIONS.has(extension)) return 'source'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  return 'unsupported'
}

export function isDocumentationFile(file: { language?: string; relPath: string }): boolean {
  return file.language === 'markdown' || file.language === 'text' ||
    classifyProjectFile(file.relPath) === 'document'
}

export function isCanvasSourceFile(file: { language?: string; relPath: string }): boolean {
  return file.language !== 'markdown' && file.language !== 'text' && classifyProjectFile(file.relPath) === 'source'
}
