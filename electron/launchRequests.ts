import { isAbsolute, resolve } from 'path'

// Every way of asking Axiom to open something - `axiom .` in a terminal, a
// folder dropped on the dock icon, a jump-list entry, an axiom:// link -
// becomes one of these before anything acts on it.

export type LaunchRequest =
  | { kind: 'path'; path: string }
  | { kind: 'project'; projectId: string }

/**
 * axiom://open?path=/abs/path   open (or add) the folder or file's project
 * axiom://project/<id>          open a project Axiom already knows
 */
export function parseAxiomUrl(raw: string): LaunchRequest | null {
  // A link with dot segments is never one Axiom produced; refuse it rather
  // than let URL normalisation turn it into something that looks valid.
  if (raw.includes('..')) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'axiom:') return null
  const action = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]
  if (action === 'open') {
    const path = url.searchParams.get('path')
    return path && isAbsolute(path) ? { kind: 'path', path: resolve(path) } : null
  }
  if (action === 'project') {
    const id = (url.hostname ? url.pathname : url.pathname.replace(/^\/+project/, '')).replace(/^\/+/, '')
    return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? { kind: 'project', projectId: id } : null
  }
  return null
}

/**
 * The first thing on a command line that names a location. Flags, the app's
 * own executable and (in development) the app directory are skipped.
 */
export function parseLaunchArgs(argv: readonly string[], workingDirectory: string, skip: readonly string[] = []): LaunchRequest | null {
  const skipped = new Set(skip.map(entry => resolve(entry)))
  for (const argument of argv.slice(1)) {
    if (!argument || argument.startsWith('-')) continue
    if (argument.startsWith('axiom:')) return parseAxiomUrl(argument)
    const path = resolve(workingDirectory, argument)
    if (skipped.has(path)) continue
    return { kind: 'path', path }
  }
  return null
}
