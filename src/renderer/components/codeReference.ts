/**
 * A place in the project's code that an agent pointed at. Every client writes
 * these its own way - `a.py:114`, `a.py#L114`, `a.cs(114,5)`, `a.py line 114`,
 * file://, vscode://file/, relative Markdown links, `@a.py` mentions - so this
 * reads all of them into one shape, and only for files Ambio indexed.
 */

export interface CodeReference {
  /** The indexed project path, with forward slashes. */
  relPath: string
  line?: number
  endLine?: number
}

interface CodeLocation { path: string; line?: number; endLine?: number }

const DASH = '\\s*(?:-|\u2013|\u2014|to)\\s*'
/** Location suffixes, tried in order; each captures the start and optional end line. */
const LOCATION_SUFFIXES: RegExp[] = [
  // GitHub and Codex anchors: #L12, #L12-L20, #L12C3-L20C1
  /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i,
  // Compiler style: :12, :12:5, :12-20, :12:5-20:3
  new RegExp(`:(\\d+)(?::\\d+)?(?:${DASH}(\\d+)(?::\\d+)?)?$`),
  // MSBuild and C#: (12) or (12,5)
  /\((\d+)(?:\s*,\s*\d+)?\)$/,
  // Written out: " line 12", ", lines 12-20", " L12", " (line 12)"
  new RegExp(`[\\s,]+\\(?(?:at\\s+|on\\s+)?(?:lines?|ln|L)\\.?\\s*(\\d+)(?:${DASH}(\\d+))?\\)?$`, 'i'),
]

/** Split a written reference into its path and line range. */
export function parseCodeLocation(raw: string): CodeLocation {
  let path = raw.trim()
  let line: number | undefined
  let endLine: number | undefined
  for (const suffix of LOCATION_SUFFIXES) {
    const found = suffix.exec(path)
    if (!found) continue
    path = path.slice(0, found.index)
    line = Number(found[1])
    endLine = found[2] ? Number(found[2]) : undefined
    break
  }
  path = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!line || line < 1) return { path }
  return { path, line, ...(endLine && endLine > line ? { endLine } : {}) }
}

const FILE_SHAPE = /^[\w.@-][\w.@/-]*\.[A-Za-z0-9]+$/

/**
 * The indexed file a written path means: the exact project path, the same
 * path in other letter case, an absolute path inside the project, or - as
 * agents often shorten them - a name or partial path that ends exactly one
 * indexed path. Anything ambiguous is no file.
 */
export function resolveProjectPath(written: string, relPaths: ReadonlySet<string>, projectRoot?: string): string | null {
  let path = written.replace(/\\/g, '/').replace(/^\.\//, '')
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const absolute = path.replace(/^\/(?=[a-z]:\/)/i, '')
    if (absolute.toLowerCase().startsWith(`${root}/`)) path = absolute.slice(root.length + 1)
  }
  const tries = path.startsWith('@') ? [path, path.slice(1)] : [path]
  for (const candidate of tries) {
    const found = findIndexedPath(candidate, relPaths)
    if (found) return found
  }
  return null
}

function findIndexedPath(path: string, relPaths: ReadonlySet<string>): string | null {
  if (relPaths.has(path)) return path
  if (!FILE_SHAPE.test(path)) return null
  const lower = path.toLowerCase()
  const suffix = `/${lower}`
  let caseMatch: string | null = null
  let suffixMatch: string | null = null
  let suffixAmbiguous = false
  for (const known of relPaths) {
    const knownLower = known.toLowerCase()
    if (knownLower === lower) {
      if (caseMatch) return null
      caseMatch = known
    } else if (knownLower.endsWith(suffix)) {
      if (suffixMatch) suffixAmbiguous = true
      suffixMatch = known
    }
  }
  if (caseMatch) return caseMatch
  return suffixAmbiguous ? null : suffixMatch
}

/** A reference written as text, such as inline code: `src/a.ts:12`. */
export function codeReferenceFromText(text: string, relPaths: ReadonlySet<string>, projectRoot?: string): CodeReference | null {
  const location = parseCodeLocation(text)
  const relPath = resolveProjectPath(location.path, relPaths, projectRoot)
  return relPath ? withLines(relPath, location) : null
}

/**
 * A reference written as a link target: file://, an editor's own scheme
 * (vscode://file/…, cursor://file/…), or a relative or absolute path.
 * Web links are not code references, even to a file on GitHub, whose
 * contents can differ from the checkout's.
 */
export function codeReferenceFromHref(href: string | undefined, relPaths: ReadonlySet<string>, projectRoot?: string): CodeReference | null {
  if (!href) return null
  let address = href.trim()
  const editor = /^[a-z][\w+.-]*:\/\/file\/+(.*)$/i.exec(address)
  if (/^file:/i.test(address)) address = address.replace(/^file:\/*/i, '/')
  else if (editor) address = `/${editor[1]}`
  else if (/^[a-z][a-z0-9+.-]*:/i.test(address) && !/^[a-z]:[\\/]/i.test(address)) return null
  try { address = decodeURIComponent(address) } catch { return null }
  return codeReferenceFromText(address, relPaths, projectRoot)
}

function withLines(relPath: string, location: CodeLocation): CodeReference {
  return { relPath, ...(location.line ? { line: location.line } : {}), ...(location.endLine ? { endLine: location.endLine } : {}) }
}

/** The link Ambio's renderer gives a resolved reference. */
export function codeReferenceHref(reference: CodeReference): string {
  const range = reference.line ? `#L${reference.line}${reference.endLine ? `-L${reference.endLine}` : ''}` : ''
  return `ambio://code/${encodeURIComponent(reference.relPath)}${range}`
}

export function codeReferenceFromAmbioHref(href: string): CodeReference | null {
  const found = /^ambio:\/\/code\/([^#?]+)(?:#L(\d+)(?:-L(\d+))?)?$/i.exec(href)
  if (!found) return null
  let relPath: string
  try { relPath = decodeURIComponent(found[1]) } catch { return null }
  return withLines(relPath, { path: relPath, line: found[2] ? Number(found[2]) : undefined, endLine: found[3] ? Number(found[3]) : undefined })
}

/** "line 12", "lines 12–20". */
export function describeLines(reference: Pick<CodeReference, 'line' | 'endLine'>): string {
  if (!reference.line) return ''
  return reference.endLine ? `lines ${reference.line}\u2013${reference.endLine}` : `line ${reference.line}`
}

const LINE_AFTER = new RegExp(`^[\\s,]*\\(?\\s*(?:at\\s+|on\\s+)?lines?\\s+(\\d+)(?:${DASH}(\\d+))?`, 'i')
const LINE_BEFORE = new RegExp(`\\b(?:at\\s+|on\\s+)?lines?\\s+(\\d+)(?:${DASH}(\\d+))?\\s+(?:of|in)\\s*$`, 'i')

/**
 * The line a sentence gives next to a file named without one:
 * "`a.py` line 114", "`a.py` (lines 3-9)", "line 114 of `a.py`".
 */
export function adjacentLines(before: string, after: string): { line: number; endLine?: number } | null {
  const found = LINE_AFTER.exec(after) ?? LINE_BEFORE.exec(before)
  if (!found) return null
  const line = Number(found[1])
  const endLine = found[2] ? Number(found[2]) : undefined
  if (line < 1) return null
  return { line, ...(endLine && endLine > line ? { endLine } : {}) }
}
