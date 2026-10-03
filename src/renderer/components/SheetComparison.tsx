import { useEffect, useState } from 'react'
import { useSheetStore } from '../store/sheetStore'
import { InboxIcon } from './InboxIcon'
import { archdApi } from '../archdEndpoint.ts'

export interface SheetComparisonResult {
  sheetId: string; name: string; revision: number; token: string
  equivalent: boolean; resolvedAt?: number; checked: number
  differences: Array<{ kind: string; nodeId: string; name: string; expected?: string; actual?: string; detail: string }>
  nodes: Array<{ id: string; name: string }>
  mappings: Record<string, string>
}

export function SheetComparison({ workspaceId, sheetId }: { workspaceId: string; sheetId: string }) {
  const sheetRevision = useSheetStore(state => state.sheets.find(sheet => sheet.id === sheetId)?.revision)
  const [comparison, setComparison] = useState<SheetComparisonResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let alive = true, loading = false
    setComparison(null); setError('')
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const response = await fetch(`${archdApi()}/api/sheets/${encodeURIComponent(sheetId)}/compare?workspace=${encodeURIComponent(workspaceId)}`, { signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error(await response.text())
        const result = await response.json() as SheetComparisonResult
        if (!Array.isArray(result.differences)) throw new Error('Sheet comparison is unavailable; update the Ambio daemon.')
        if (alive) { setComparison(result); setError('') }
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : String(err)) }
      finally { loading = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [workspaceId, sheetId, sheetRevision])
  const resolve = async () => {
    if (!comparison || busy) return
    setBusy(true)
    try {
      const response = await fetch(`${archdApi()}/api/sheets/${encodeURIComponent(sheetId)}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ workspaceId, revision: comparison.revision, token: comparison.token }),
      })
      if (!response.ok) throw new Error(await response.text())
      const sheet = await response.json()
      setComparison(current => current ? { ...current, resolvedAt: sheet.resolvedAt } : current)
      setExpanded(false)
      await useSheetStore.getState().fetchSheets(workspaceId)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const label = (id?: string) => !id ? 'Root' : comparison?.nodes.find(node => node.id === id || comparison.mappings[node.id] === id)?.name ?? id
  return <section className="ambio-inbox__comparison" aria-label="Sheet comparison">
    <button type="button" className="ambio-inbox__comparison-summary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className={`ambio-inbox__comparison-glyph${comparison?.equivalent ? ' ambio-inbox__comparison-glyph--match' : ''}`}><InboxIcon name={comparison?.equivalent ? 'check' : 'sheet'} size={16} /></span>
      <span><strong>{error ? 'Sheet comparison unavailable' : comparison?.resolvedAt ? 'Sheet resolved · saved in history' : comparison?.equivalent ? 'Structure matches the live canvas' : comparison ? `${comparison.differences.length} structural ${comparison.differences.length === 1 ? 'difference' : 'differences'}` : 'Comparing sheet with live canvas…'}</strong><small>{comparison?.name ?? 'Attached sheet'} · live comparison</small></span><InboxIcon name="chevron" size={15} />
    </button>
    {expanded && <div className="ambio-inbox__comparison-detail">
      {comparison && <small>Revision {comparison.revision} · {comparison.checked} requirements checked. Position and size are ignored.</small>}
      {error && <p role="alert">{error}</p>}
      {!!comparison?.differences.length && <details open><summary>Show remaining differences</summary><ul>{comparison.differences.slice(0,100).map((difference,index) => <li key={`${difference.nodeId}:${difference.kind}:${index}`}>
        <strong>{difference.name} · {difference.kind}</strong><span>{difference.detail}</span>
        {(difference.kind === 'nesting' || difference.kind === 'parent') && <span>{label(difference.actual)} → {label(difference.expected)}</span>}
      </li>)}</ul>{comparison.differences.length>100 && <small>Showing the first 100 differences. The agent can read the full comparison.</small>}</details>}
      <div className="ambio-inbox__comparison-actions"><button type="button" onClick={() => { void useSheetStore.getState().openSheet(workspaceId, null) }}>Watch live canvas</button>
        {comparison?.equivalent && !comparison.resolvedAt && <button type="button" disabled={busy || !!error} onClick={() => { void resolve() }}>{busy ? 'Resolving…' : 'Resolve sheet'}</button>}
      </div>
      <small>Resolution checks structure, not runtime behavior. Resolved sheets leave the active canvas and can be restored.</small>
    </div>}
  </section>
}
