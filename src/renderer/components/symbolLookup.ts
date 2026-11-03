import { useEffect, useState } from 'react'
import { searchSymbols } from '../canvas/symbolSearch'
import { useGraphStore } from '../store/graphStore'
import { parseSymbolCandidate, pickSymbol, type FileHints, type SymbolHit } from './symbolReference'

/**
 * Symbols exactly named `name`, from archd. Replies re-render on every
 * streamed token and name the same symbols again and again, so answers are
 * kept until the index changes (a new files list).
 */
let cache = new Map<string, Promise<SymbolHit[]>>()
let cachedFiles: unknown = null

function symbolsNamed(workspaceId: string, name: string, fresh = false): Promise<SymbolHit[]> {
  const files = useGraphStore.getState().files
  if (files !== cachedFiles) { cache = new Map(); cachedFiles = files }
  const key = `${workspaceId}\n${name}`
  let pending = fresh ? undefined : cache.get(key)
  if (!pending) {
    // Exact matches rank first, so 200 holds every definition of a real name.
    pending = searchSymbols(workspaceId, name, undefined, 200)
      .then(hits => (hits as SymbolHit[]).filter(hit => hit.name === name))
      .catch(() => [])
    cache.set(key, pending)
  }
  return pending
}

/** The definition inline code names, or null while unknown or when it is not clear. */
export async function resolveSymbol(workspaceId: string, text: string, hints: FileHints, relPaths: ReadonlySet<string>, projectRoot?: string, fresh = false): Promise<SymbolHit | null> {
  const candidate = parseSymbolCandidate(text, relPaths, projectRoot)
  if (!candidate || !workspaceId) return null
  const [hits, containers] = await Promise.all([
    symbolsNamed(workspaceId, candidate.name, fresh),
    candidate.container ? symbolsNamed(workspaceId, candidate.container, fresh) : Promise.resolve([]),
  ])
  return pickSymbol(candidate, hits, containers, hints)
}

export function useResolvedSymbol(workspaceId: string, text: string, hints: FileHints, relPaths: ReadonlySet<string>, projectRoot?: string): SymbolHit | null {
  const [found, setFound] = useState<SymbolHit | null>(null)
  const files = useGraphStore(state => state.files)
  const hintKey = `${hints.nearby.join('\n')}\u0000${hints.message.join('\n')}`
  useEffect(() => {
    let current = true
    void resolveSymbol(workspaceId, text, hints, relPaths, projectRoot).then(hit => { if (current) setFound(hit) })
    return () => { current = false }
    // hints is rebuilt each render; hintKey is its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, text, hintKey, relPaths, projectRoot, files])
  return found
}
