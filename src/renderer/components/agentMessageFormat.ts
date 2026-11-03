/**
 * Agent replies are Markdown, rendered by react-markdown (never as HTML). What
 * is here repairs the patterns agents get wrong and turns project paths into
 * something a person can read and click.
 */

import { adjacentLines, codeReferenceFromAmbioHref, codeReferenceFromHref, codeReferenceFromText, codeReferenceHref } from './codeReference.ts'

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

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }
/** Parse only Ambio's artifact links; custom schemes need no browser URL handling. */
export function architectureLinkTarget(href: string): { type: 'sheet' | 'system'; id: string } | null {
  const target = /^ambio:\/\/(sheet|system)\/([^?#]+)$/i.exec(href)
  if (!target) return null
  try { return { type: target[1].toLowerCase() as 'sheet' | 'system', id: decodeURIComponent(target[2]) } } catch { return null }
}

/** Where a path is already code, a link or raw text, it is left as written. */
const KEEP_AS_WRITTEN = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html'])
const markdownText = (node: MarkdownNode): string => node.value ?? (node.children ?? []).map(markdownText).join('')

/** A file name in prose, with any location suffix a client writes after it. */
const PROSE_REFERENCE = /[\w.@-][\w.@/\\-]*\.[A-Za-z0-9]+(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:[-\u2013]\d+(?::\d+)?)?|\(\d+(?:,\s*\d+)?\))?/g

/**
 * A remark plugin: every way an agent names a project file - inline code,
 * plain prose ("see query_builder.py:40"), or a link of any scheme - becomes
 * one `ambio://code/` link carrying the file and line, so each renders as the
 * same chip whichever client wrote it. A line given beside the name ("`a.py`
 * line 40", "line 40 of `a.py`") is attached to it. Code blocks and unknown
 * files stay as written.
 */
export function remarkCodeReferences(relPaths: ReadonlySet<string>, projectRoot?: string) {
  const reference = (url: string, label: string): MarkdownNode => ({ type: 'link', url, children: [{ type: 'text', value: label }] })
  const split = (text: string): MarkdownNode[] | null => {
    const parts: MarkdownNode[] = []
    let last = 0
    for (const found of text.matchAll(PROSE_REFERENCE)) {
      const start = found.index ?? 0
      // Part of a longer word or URL ("example.com/x.py", "a:b.py") is not a path on its own.
      if (start > 0 && /[\w:/\\]/.test(text[start - 1])) continue
      const target = codeReferenceFromText(found[0], relPaths, projectRoot)
      if (!target) continue
      if (start > last) parts.push({ type: 'text', value: text.slice(last, start) })
      parts.push(reference(codeReferenceHref(target), found[0]))
      last = start + found[0].length
    }
    if (!parts.length) return null
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
    return parts
  }
  const created = new WeakSet<MarkdownNode>()
  const walk = (node: MarkdownNode) => {
    if (!node.children || KEEP_AS_WRITTEN.has(node.type)) return
    node.children = node.children.flatMap(child => {
      if (child.type === 'text' && child.value) {
        const parts = split(child.value)
        parts?.forEach(part => { if (part.type === 'link') created.add(part) })
        return parts ?? [child]
      }
      if (child.type === 'inlineCode' && child.value) {
        const target = codeReferenceFromText(child.value, relPaths, projectRoot)
        if (!target) return [child]
        const link = reference(codeReferenceHref(target), child.value.trim())
        created.add(link)
        return [link]
      }
      if (child.type === 'link') {
        const target = codeReferenceFromHref(child.url, relPaths, projectRoot)
        if (!target) return [child]
        child.url = codeReferenceHref(target)
        created.add(child)
        // "[executor.py](…/executor.py#L50-L67)": the line is only in the address, so show it.
        const range = target.line ? `${target.line}${target.endLine ? `–${target.endLine}` : ''}` : ''
        const text = markdownText(child)
        if (!text.trim()) child.children = [{ type: 'text', value: `${target.relPath}${range ? `:${range}` : ''}` }]
        else if (range && !text.includes(String(target.line))) child.children = [...(child.children ?? []), { type: 'text', value: `:${range}` }]
        return [child]
      }
      walk(child)
      return [child]
    })
    // "`a.py` line 40" or "line 40 of `a.py`": the sentence gives the line.
    node.children.forEach((child, index, siblings) => {
      if (!created.has(child) || !child.url || child.url.includes('#L')) return
      const before = siblings[index - 1]?.type === 'text' ? siblings[index - 1].value ?? '' : ''
      const after = siblings[index + 1]?.type === 'text' ? siblings[index + 1].value ?? '' : ''
      const lines = adjacentLines(before, after)
      const target = lines && codeReferenceFromAmbioHref(child.url)
      if (target && lines) child.url = codeReferenceHref({ ...target, ...lines })
    })
  }
  return () => (tree: MarkdownNode) => { if (relPaths.size) walk(tree) }
}

/** Make map references readable even in replies written before the response
 * guidance was installed. Code blocks and link destinations stay verbatim. */
export function remarkArchitectureNames(references: Array<{ id: string; name: string; type: 'sheet' | 'system' }>) {
  const names = new Map<string, typeof references[number]>()
  const ambiguous = new Set<string>()
  for (const reference of references) {
    if (names.has(reference.name)) ambiguous.add(reference.name)
    names.set(reference.name, reference)
  }
  const candidates = references.flatMap(reference => [{ text: reference.id, reference }, ...(!ambiguous.has(reference.name) && reference.name.length > 3 ? [{ text: reference.name, reference }] : [])]).sort((a, b) => b.text.length - a.text.length)
  const walk = (node: MarkdownNode) => {
    if (!node.children || KEEP_AS_WRITTEN.has(node.type)) return
    node.children = node.children.flatMap(child => {
      if (child.type === 'inlineCode') {
        if (child.value === 'DEPENDS_ON') return [{ type: 'text', value: 'uses' }]
        const ref = references.find(reference => reference.id === child.value)
        if (ref) return [{ type: 'link', url: `ambio://${ref.type}/${encodeURIComponent(ref.id)}`, children: [{ type: 'text', value: ref.name }] }]
      }
      if (child.type !== 'text' || !child.value) { walk(child); return [child] }
      const value = child.value.replace(/\s*\(ID\s+[a-f0-9]{8}-[a-f0-9-]{27,}\)/gi, '').replace(/\bDEPENDS_ON\b/g, 'uses')
      const parts: MarkdownNode[] = []
      let offset = 0
      while (offset < value.length) {
        let best: { index: number; text: string; reference: typeof references[number] } | undefined
        for (const candidate of candidates) {
          const index = value.indexOf(candidate.text, offset)
          if (index >= 0 && (!best || index < best.index)) best = { index, ...candidate }
        }
        if (!best) { parts.push({ type: 'text', value: value.slice(offset) }); break }
        if (best.index > offset) parts.push({ type: 'text', value: value.slice(offset, best.index) })
        parts.push({ type: 'link', url: `ambio://${best.reference.type}/${encodeURIComponent(best.reference.id)}`, children: [{ type: 'text', value: best.reference.name }] })
        offset = best.index + best.text.length
      }
      return parts
    })
  }
  return () => (tree: MarkdownNode) => walk(tree)
}
