import { useEffect, useState } from 'react'
import { archdApi } from '../archdEndpoint.ts'

interface DraftSummary {
  sessionId: string
  rationale: string
  chunkCount: number
  systemCount: number
  updatedAt: number
}

/**
 * The unfinished architecture drafts for a project, newest first, and a way to
 * discard the newest. pollMs keeps it current while something is mapping;
 * otherwise it refreshes on draft events and when the window regains focus.
 */
export function useProposalDrafts(workspaceId: string, pollMs?: number) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setDrafts([])
    setError('')
    const refresh = async () => {
      try {
        const response = await fetch(`${archdApi()}/api/architecture-proposal-drafts?workspace=${encodeURIComponent(workspaceId)}`)
        if (!response.ok) return
        const next = await response.json() as DraftSummary[]
        if (active) setDrafts(next)
      } catch { /* the daemon may still be starting; its next event refreshes */ }
    }
    const onUpdate = () => { void refresh() }
    // This status is background context and can wait until the canvas frames.
    const timer = window.setTimeout(onUpdate, 250)
    const poll = pollMs ? window.setInterval(onUpdate, pollMs) : undefined
    window.addEventListener('ambio:proposal-draft', onUpdate)
    window.addEventListener('focus', onUpdate)
    return () => {
      active = false
      window.clearTimeout(timer)
      if (poll) window.clearInterval(poll)
      window.removeEventListener('ambio:proposal-draft', onUpdate)
      window.removeEventListener('focus', onUpdate)
    }
  }, [workspaceId, pollMs])

  const newest = drafts[0] as DraftSummary | undefined
  const discard = async () => {
    if (!newest || !window.confirm('Discard this unfinished architecture draft and its saved chunks?')) return
    setDiscarding(true)
    setError('')
    try {
      const response = await fetch(`${archdApi()}/api/architecture-proposal-drafts/${encodeURIComponent(newest.sessionId)}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      if (!response.ok) throw new Error('Could not discard draft')
      setDrafts(current => current.filter(draft => draft.sessionId !== newest.sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not discard draft')
    } finally {
      setDiscarding(false)
    }
  }
  return { drafts, newest, discard, discarding, error }
}

/** The draft is visible as progress, never as an approved map. */
export function ProposalDraftProgress({ workspaceId, inline = false }: { workspaceId: string; inline?: boolean }) {
  const { drafts, newest, discard, discarding, error } = useProposalDrafts(workspaceId)
  if (!newest) return null
  const recentlyUpdated = Date.now() - newest.updatedAt < 5 * 60_000
  return (
    <aside className={`ambio-draft-progress${inline ? ' ambio-draft-progress--inline' : ''}`} role="status" aria-live="polite" aria-label="Architecture mapping progress">
      <span className="ambio-draft-progress__pulse" aria-hidden="true" />
      <div className="ambio-draft-progress__content">
        <strong>{recentlyUpdated ? 'Agent mapping architecture' : 'Architecture draft paused'}</strong>
        <p>{newest.systemCount} systems in {newest.chunkCount} {newest.chunkCount === 1 ? 'chunk' : 'chunks'}
          {drafts.length > 1 ? ` · ${drafts.length} open sessions` : ''}</p>
      </div>
      <button type="button" onClick={() => { void discard() }} disabled={discarding} title="Discard this unfinished draft and its saved chunks">
        {discarding ? 'Discarding…' : 'Discard'}
      </button>
      {error && <span className="ambio-draft-progress__error" role="alert">{error}</span>}
    </aside>
  )
}
