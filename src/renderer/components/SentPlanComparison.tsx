import { useEffect, useState } from 'react'
import { archdApi } from '../archdEndpoint.ts'

interface SentDifference {
  kind: string
  nodeId: string
  name: string
  expected?: string
  actual?: string
  detail: string
}

interface SentComparison {
  equivalent: boolean
  checked: number
  differences: SentDifference[]
}


export function SentPlanComparison({ workspaceId, messageId }: { workspaceId: string; messageId: string }) {
  const [comparison, setComparison] = useState<SentComparison | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let alive = true, loading = false
    setComparison(null); setError('')
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const response = await fetch(`${archdApi()}/api/canvas/snapshot-comparison?workspace=${encodeURIComponent(workspaceId)}&messageId=${encodeURIComponent(messageId)}`, { signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error(await response.text())
        const result = await response.json() as SentComparison
        if (!Array.isArray(result.differences) || typeof result.equivalent !== 'boolean') throw new Error('Sent-plan comparison is unavailable; update the Ambio daemon.')
        if (alive) { setComparison(result); setError('') }
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : 'Could not compare the sent plan.')
      } finally { loading = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [workspaceId, messageId])

  const unverifiable = comparison?.differences.some(difference => difference.kind === 'unverifiable') ?? false
  const state = error ? 'error' : !comparison ? 'loading' : comparison.equivalent ? 'matched' : 'different'
  const headline = error ? 'Sent-plan check unavailable'
    : !comparison ? 'Checking the sent plan against live architecture…'
      : comparison.equivalent ? 'Sent structure matches the live architecture'
        : unverifiable ? 'Sent structure has unverified requirements'
          : `${comparison.differences.length} sent-plan structural ${comparison.differences.length === 1 ? 'difference' : 'differences'}`

  return <section className="ambio-inbox__sent-check" data-state={state} aria-label="Sent plan versus live architecture">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <strong>{headline}</strong><span>{expanded ? 'Hide details' : 'Details'}</span>
    </button>
    {expanded && <div className="ambio-inbox__sent-check-detail">
      {comparison && <p>{comparison.checked} sent structural {comparison.checked === 1 ? 'requirement' : 'requirements'} checked against the current indexed model.</p>}
      {error && <p role="alert">{error}</p>}
      {!!comparison?.differences.length && <ul>{comparison.differences.slice(0, 100).map((difference, index) => <li key={`${difference.nodeId}:${difference.kind}:${index}`}><strong>{difference.name} · {difference.kind}</strong><span>{difference.detail}</span></li>)}</ul>}
      {(comparison?.differences.length ?? 0) > 100 && <small>Showing the first 100 differences.</small>}
      <small>This checks structure and indexed source contracts. The agent's tests and prose claims need separate review.</small>
    </div>}
  </section>
}
