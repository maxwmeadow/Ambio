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

/** A project-relative path written in inline code, when it names a file Ambio indexed. */
export function inlineFilePath(text: string, relPaths: ReadonlySet<string>): string | null {
  const candidate = text.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/:(\d+)(-\d+)?$/, '')
  return relPaths.has(candidate) ? candidate : null
}
