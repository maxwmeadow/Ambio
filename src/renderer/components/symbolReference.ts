/**
 * A function, class or other symbol an agent named in a reply, and which
 * indexed definition it means. Clients write these many ways - `run`,
 * `run()`, `Scene.update`, `Scene::update`, `Scene#update`, `def run`,
 * `heuristics.evaluate_scene`, `heuristics.py::evaluate_scene` - and a name
 * is only taken to mean a definition when that is clear: one match, or one
 * in a file the reply names. Anything else stays plain code.
 */

import { resolveProjectPath } from './codeReference.ts'

export interface SymbolCandidate {
  name: string
  /** The class, type or module written before the name: `Scene` in `Scene.update`. */
  container?: string
  /** The project file written before the name: `a.py::run`. */
  file?: string
}

/** What archd's symbol search returns. */
export interface SymbolHit {
  id: string
  fileId: string
  name: string
  kind: string
  lineStart: number
  lineEnd: number
  relPath: string
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const DECLARATION = /^(?:def|function|func|fn|class|interface|struct|enum|trait|type|method|async\s+def|async\s+function)\s+/
/** Words that are never a project's own symbol, however a reply quotes them. */
const NOT_SYMBOLS = new Set(['true', 'false', 'null', 'none', 'nil', 'undefined', 'self', 'this', 'cls', 'super', 'return', 'await', 'async', 'new', 'void', 'main'])
/** A receiver, not a class: `self.run` means run. */
const RECEIVERS = new Set(['self', 'this', 'cls', 'super'])

/** Read inline code as a symbol name, or null when it is not shaped like one. */
export function parseSymbolCandidate(text: string, relPaths: ReadonlySet<string> = new Set(), projectRoot?: string): SymbolCandidate | null {
  let written = text.trim().replace(DECLARATION, '')
  // Call parentheses, with or without arguments: run(), run(a, b=1).
  written = written.replace(/\((?:[^()]|\([^()]*\))*\)$/, '').trim()
  let file: string | undefined
  // A file before the name: tests/a.py::test_run (pytest), a.py:run, a.go#Run.
  const scoped = /^(.+?\.[A-Za-z0-9]+)(?:::|:|#)([A-Za-z_$][\w$.:#]*)$/.exec(written)
  const path = scoped && resolveProjectPath(scoped[1], relPaths, projectRoot)
  if (scoped && path) {
    file = path
    written = scoped[2]
  }
  const segments = written.split(/::|->|\.|#/)
  if (!segments.every(segment => IDENTIFIER.test(segment))) return null
  const name = segments[segments.length - 1]
  const qualifier = segments.length > 1 ? segments[segments.length - 2] : undefined
  if (name.length < 2 || NOT_SYMBOLS.has(name.toLowerCase())) return null
  const container = qualifier && !RECEIVERS.has(qualifier) ? qualifier : undefined
  return { name, ...(container ? { container } : {}), ...(file ? { file } : {}) }
}

const stem = (relPath: string) => relPath.split('/').pop()!.replace(/\.[^.]+$/, '')
const encloses = (outer: SymbolHit, inner: SymbolHit) => outer.id !== inner.id && outer.fileId === inner.fileId &&
  outer.lineStart <= inner.lineStart && inner.lineEnd <= outer.lineEnd

/** Files the reply names: those in the same paragraph first, then the whole message. */
export interface FileHints { nearby: readonly string[]; message: readonly string[] }

/**
 * The one definition a candidate means, from archd's hits for its name and
 * (for `Scene.update`) for its container. Null when it could be several.
 */
export function pickSymbol(candidate: SymbolCandidate, hits: readonly SymbolHit[], containers: readonly SymbolHit[] = [], hints: FileHints = { nearby: [], message: [] }): SymbolHit | null {
  let pool = hits.filter(hit => hit.name === candidate.name)
  if (candidate.file) pool = pool.filter(hit => hit.relPath === candidate.file)
  if (candidate.container) {
    const owners = containers.filter(owner => owner.name === candidate.container)
    const inType = pool.filter(hit => owners.some(owner => encloses(owner, hit)))
    const inModule = pool.filter(hit => stem(hit.relPath) === candidate.container)
    // `scene.update` names an instance, not a type: fall back to the bare name.
    if (inType.length) pool = inType
    else if (inModule.length) pool = inModule
  }
  if (pool.length === 1) return pool[0]
  for (const files of [hints.nearby, hints.message]) {
    if (!files.length) continue
    const named = pool.filter(hit => files.includes(hit.relPath))
    if (named.length === 1) return named[0]
    if (named.length > 1) { pool = named; break }
  }
  // A function and a variable of the same name: the definition is meant.
  const definitions = pool.filter(hit => hit.kind !== 'variable')
  return definitions.length === 1 ? definitions[0] : null
}

export function symbolHref(text: string, hints: FileHints): string {
  const params = new URLSearchParams()
  if (hints.nearby.length) params.set('near', hints.nearby.join('\n'))
  if (hints.message.length) params.set('msg', hints.message.join('\n'))
  const query = params.toString()
  return `ambio://symbol/${encodeURIComponent(text)}${query ? `?${query}` : ''}`
}

export function symbolFromAmbioHref(href: string): { text: string; hints: FileHints } | null {
  const found = /^ambio:\/\/symbol\/([^?#]+)(?:\?([^#]*))?$/i.exec(href)
  if (!found) return null
  try {
    const params = new URLSearchParams(found[2] ?? '')
    const list = (key: string) => params.get(key)?.split('\n').filter(Boolean) ?? []
    return { text: decodeURIComponent(found[1]), hints: { nearby: list('near'), message: list('msg') } }
  } catch { return null }
}
