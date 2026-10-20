import { useEffect, useState } from 'react'
import { archdApi } from '../archdEndpoint.ts'
import { emitCommand, useCommandHandlers } from '../app/commands'
import { raiseFailure, raiseNotice, resolveInterruption, useInterruptionStore } from '../store/interruptionStore'

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
    if (!newest || !window.confirm('Discard this unfinished architecture draft? Your code and current map will be kept.')) return
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
  const { newest, discard, discarding, error } = useProposalDrafts(workspaceId)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const remaining = (newest?.updatedAt ?? 0) + 5 * 60_000 - Date.now()
    setPaused(remaining <= 0)
    if (remaining <= 0) return
    const timer = setTimeout(() => setPaused(true), remaining)
    return () => clearTimeout(timer)
  }, [newest?.updatedAt])
  const show = () => {
    if (!newest) { raiseNotice('no-map-draft', 'No unfinished architecture draft'); return }
    useInterruptionStore.getState().raise({
      id: 'map-draft', kind: paused ? 'invitation' : 'progress',
      title: paused ? 'An architecture draft is unfinished' : 'Your agent is mapping the project…',
      body: paused ? 'Ask your agent to continue, or discard this draft.' : 'The proposed map will be ready to review when the agent finishes.',
      createdAt: newest.updatedAt,
      actions: [
        { label: 'Open chat', run: () => emitCommand('agent.message') },
        { label: discarding ? 'Discarding…' : 'Discard draft', run: async () => { if (!discarding) await discard() } },
      ],
      onDismiss: () => setDismissed(newest.sessionId),
      dismissHint: 'Hide — reopen from Agent → Architecture Draft',
    })
  }
  useCommandHandlers(inline ? {} : { 'agent.architectureDraft': () => { setDismissed(null); show() } })
  useEffect(() => {
    if (inline) return
    if (!newest || dismissed === newest.sessionId) { resolveInterruption('map-draft'); return }
    show()
  }, [newest, dismissed, paused, discarding, inline])
  useEffect(() => {
    if (inline) return
    if (error) raiseFailure('map-draft-error', 'Could not discard the architecture draft', error)
    else resolveInterruption('map-draft-error')
  }, [error, inline])
  useEffect(() => () => {
    if (!inline) { resolveInterruption('map-draft'); resolveInterruption('map-draft-error') }
  }, [inline])
  if (inline && newest) return <aside className="ambio-draft-progress ambio-draft-progress--inline" role="status" aria-label="Architecture mapping progress">
    <div className="ambio-draft-progress__content"><strong>{paused ? 'An architecture draft is unfinished' : 'Your agent is mapping the project…'}</strong><p>{newest.systemCount} systems drafted</p></div>
    <button type="button" disabled={discarding} onClick={() => void discard()}>{discarding ? 'Discarding…' : 'Discard draft'}</button>
    {error && <span role="alert">{error}</span>}
  </aside>
  return null
}
