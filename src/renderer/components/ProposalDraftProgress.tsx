import { useEffect, useState } from 'react'

interface DraftSummary {
  sessionId: string
  rationale: string
  chunkCount: number
  systemCount: number
  updatedAt: number
}

/** The draft is visible as progress, never as an approved map. */
export function ProposalDraftProgress({ workspaceId, inline = false }: { workspaceId: string; inline?: boolean }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setDrafts([])
    setError('')
    const refresh = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:7743/api/architecture-proposal-drafts?workspace=${encodeURIComponent(workspaceId)}`)
        if (!response.ok) return
        const next = await response.json() as DraftSummary[]
        if (active) setDrafts(next)
      } catch { /* the daemon may still be starting; its next event refreshes */ }
    }
    const onUpdate = () => { void refresh() }
    // This status is background context and can wait until the canvas frames.
    const timer = window.setTimeout(onUpdate, 250)
    window.addEventListener('axiom:proposal-draft', onUpdate)
    window.addEventListener('focus', onUpdate)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('axiom:proposal-draft', onUpdate)
      window.removeEventListener('focus', onUpdate)
    }
  }, [workspaceId])

  if (drafts.length === 0) return null
  const newest = drafts[0]
  const recentlyUpdated = Date.now() - newest.updatedAt < 5 * 60_000
  const discard = async () => {
    if (!window.confirm('Discard this unfinished architecture draft and its saved chunks?')) return
    setDiscarding(true)
    setError('')
    try {
      const response = await fetch(`http://127.0.0.1:7743/api/architecture-proposal-drafts/${encodeURIComponent(newest.sessionId)}/abort`, {
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
  return (
    <aside className={`axiom-draft-progress${inline ? ' axiom-draft-progress--inline' : ''}`} role="status" aria-live="polite" aria-label="Architecture mapping progress">
      <span className="axiom-draft-progress__pulse" aria-hidden="true" />
      <div className="axiom-draft-progress__content">
        <strong>{recentlyUpdated ? 'Agent mapping architecture' : 'Architecture draft paused'}</strong>
        <p>{newest.systemCount} systems in {newest.chunkCount} {newest.chunkCount === 1 ? 'chunk' : 'chunks'}
          {drafts.length > 1 ? ` · ${drafts.length} open sessions` : ''}</p>
      </div>
      <button type="button" onClick={() => { void discard() }} disabled={discarding} title="Discard this unfinished draft and its saved chunks">
        {discarding ? 'Discarding…' : 'Discard'}
      </button>
      {error && <span className="axiom-draft-progress__error" role="alert">{error}</span>}
    </aside>
  )
}
