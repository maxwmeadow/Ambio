import { useEffect, useState } from 'react'

interface SnapshotResponse {
  sheetContext: string
  buildSpec: string
}

interface SentContext {
  sheet?: { name?: string; purpose?: string; revision?: number }
  nodes?: Array<{ id: string; name: string; type: string; planned?: boolean }>
  edges?: Array<{ kind: string; source: string; target: string; planned?: boolean }>
  notes?: Array<{ body: string }>
}

const api = 'http://127.0.0.1:7743'

export function SentSheetSnapshot({ workspaceId, messageId }: { workspaceId: string; messageId: string }) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || snapshot) return
    let alive = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    void fetch(`${api}/api/canvas/snapshot?workspace=${encodeURIComponent(workspaceId)}&messageId=${encodeURIComponent(messageId)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await response.text())
        return response.json() as Promise<SnapshotResponse>
      })
      .then(result => { if (alive) { setSnapshot(result); setError('') } })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Could not load the sent plan.') })
      .finally(() => clearTimeout(timeout))
    return () => { alive = false; controller.abort(); clearTimeout(timeout) }
  }, [open, snapshot, workspaceId, messageId])

  let context: SentContext | null = null
  if (snapshot?.sheetContext) {
    try { context = JSON.parse(snapshot.sheetContext) as SentContext } catch { /* older orders may lack structured context */ }
  }
  const nodes = context?.nodes ?? []
  const plannedEdges = context?.edges?.filter(edge => edge.planned) ?? []
  const notes = context?.notes ?? []

  return <div className="axiom-inbox__sent-plan">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide sent plan' : 'View sent plan'}</button>
    {open && <div className="axiom-inbox__sent-plan-body">
      {error && <p role="alert">{error}</p>}
      {!snapshot && !error && <p>Loading the plan sent with this order…</p>}
      {snapshot && <>
        {context?.sheet && <p><strong>{context.sheet.name || 'Sheet'}</strong>{context.sheet.revision ? ` · revision ${context.sheet.revision}` : ''}{context.sheet.purpose ? ` · ${context.sheet.purpose}` : ''}</p>}
        {context && <p>{nodes.length} nodes · {plannedEdges.length} planned relationships · {notes.length} notes in the sent snapshot</p>}
        {!!nodes.length && <details><summary>Nodes sent ({nodes.length})</summary><ul>{nodes.slice(0, 100).map(node => <li key={node.id}>{node.name} · {node.type}{node.planned ? ' · planned' : ''}</li>)}</ul>{nodes.length > 100 && <small>Showing the first 100 nodes.</small>}</details>}
        {!!plannedEdges.length && <details><summary>Planned relationships ({plannedEdges.length})</summary><ul>{plannedEdges.slice(0, 100).map((edge, index) => <li key={`${edge.source}:${edge.target}:${index}`}>{edge.source} → {edge.target} · {edge.kind}</li>)}</ul>{plannedEdges.length > 100 && <small>Showing the first 100 relationships.</small>}</details>}
        {snapshot.buildSpec && <details open><summary>Approved build specification</summary><pre>{snapshot.buildSpec}</pre></details>}
        {!context && !snapshot.buildSpec && <p>This older order has no saved sheet plan.</p>}
      </>}
    </div>}
  </div>
}
