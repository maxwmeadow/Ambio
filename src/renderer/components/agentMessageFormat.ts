/**
 * Agent replies are Markdown, rendered by react-markdown (never as HTML). What
 * is here repairs the patterns agents get wrong and turns project paths into
 * something a person can read and click.
 */

/**
 * Text as the agent meant it.
 *
 * - A backspace or form feed never belongs in a reply: it is a "\b" or "\f"
 *   the agent wrote meaning the letter (`\backend`), decoded by JSON into a
 *   control character. The letter is put back.
 * - A code fence written with one or two backticks (`` `python ``) is made a
 *   real fence when it has a closing line.
 * - The project's own folder is dropped from absolute paths in the text, so
 *   `C:\Users\me\shop\src\a.ts` reads `src\a.ts`. Link targets keep theirs.
 */
export function normalizeAgentText(text: string, projectRoot?: string): string {
  let result = text.replace(/\u0008/g, 'b').replace(/\u000c/g, 'f').replace(/\r\n/g, '\n')

  const lines = result.split('\n')
  const shortFence = /^(\s*)`{1,2}([\w+#.-]*)\s*$/
  for (let i = 0; i < lines.length; i++) {
    const open = shortFence.exec(lines[i])
    if (!open) continue
    const close = lines.findIndex((line, j) => j > i && /^\s*`{1,2}\s*$/.test(line))
    if (close < 0) continue
    lines[i] = `${open[1]}\`\`\`${open[2]}`
    lines[close] = `${open[1]}\`\`\``
    i = close
  }
  result = lines.join('\n')

  if (projectRoot) {
    const root = projectRoot.replace(/[\\/]+$/, '')
    const pattern = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\|\//g, '[\\\\/]')
    // Not inside a file:// link target, where the full path is the address.
    result = result.replace(new RegExp(`(?<!file:\\/\\/\\/?)${pattern}[\\\\/]`, 'gi'), '')
  }
  return result
}

export interface FileLinkTarget {
  /** The path inside the project, with forward slashes; absent when outside it. */
  relPath?: string
  absolute: string
  /** "50" or "50-67", from a #L50 or #L50-L67 anchor. */
  lines?: string
}

/** What a file:// link points at, relative to the project when it is inside it. */
export function fileLinkTarget(href: string | undefined, projectRoot?: string): FileLinkTarget | null {
  if (!href || !/^file:/i.test(href)) return null
  const [address, anchor = ''] = href.split('#')
  let path: string
  try { path = decodeURIComponent(address.replace(/^file:\/*/i, '')) } catch { return null }
  // file:///C:/x -> C:/x on Windows; file:///home/x -> /home/x elsewhere.
  if (!/^[a-z]:\//i.test(path)) path = `/${path}`
  const range = /^L(\d+)(?:-L?(\d+))?$/i.exec(anchor)
  const lines = range ? (range[2] ? `${range[1]}-${range[2]}` : range[1]) : undefined
  const target: FileLinkTarget = { absolute: path, ...(lines ? { lines } : {}) }
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (path.toLowerCase().startsWith(`${root}/`)) target.relPath = path.slice(root.length + 1)
  }
  return target
}

/**
 * A file named in inline code, when it is one Ambio indexed: its full project
 * path, or - as agents often shorten them - a bare name or partial path that
 * ends exactly one indexed path. An ambiguous name stays plain code.
 */
export function inlineFilePath(text: string, relPaths: ReadonlySet<string>): string | null {
  const candidate = text.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/:(\d+)(-\d+)?$/, '')
  if (relPaths.has(candidate)) return candidate
  // Only something shaped like a file name: no spaces or wildcards, with an extension.
  if (!/^[\w.@-][\w.@/-]*\.[A-Za-z0-9]+$/.test(candidate)) return null
  const suffix = `/${candidate}`
  let match: string | null = null
  for (const path of relPaths) {
    if (!path.endsWith(suffix)) continue
    if (match) return null
    match = path
  }
  return match
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] }
/** Where a path is already code, a link or raw text, it is left as written. */
const KEEP_AS_WRITTEN = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html'])
const FILE_NAME = /[\w.@-][\w.@/-]*\.[A-Za-z0-9]+/g

/**
 * A remark plugin: file names written as plain prose ("see query_builder.py")
 * become inline code when they name a file Ambio indexed, so they render as
 * the same chips as paths the agent put in backticks.
 */
export function remarkFilePaths(relPaths: ReadonlySet<string>) {
  const split = (text: string): MarkdownNode[] | null => {
    const parts: MarkdownNode[] = []
    let last = 0
    for (const found of text.matchAll(FILE_NAME)) {
      const start = found.index ?? 0
      // Part of a longer word or URL ("example.com/x.py", "a:b.py") is not a path on its own.
      if (start > 0 && /[\w:/]/.test(text[start - 1])) continue
      if (!inlineFilePath(found[0], relPaths)) continue
      if (start > last) parts.push({ type: 'text', value: text.slice(last, start) })
      parts.push({ type: 'inlineCode', value: found[0] })
      last = start + found[0].length
    }
    if (!parts.length) return null
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
    return parts
  }
  const walk = (node: MarkdownNode) => {
    if (!node.children || KEEP_AS_WRITTEN.has(node.type)) return
    node.children = node.children.flatMap(child => {
      if (child.type === 'text' && child.value) return split(child.value) ?? [child]
      walk(child)
      return [child]
    })
  }
  return () => (tree: MarkdownNode) => { if (relPaths.size) walk(tree) }
}
