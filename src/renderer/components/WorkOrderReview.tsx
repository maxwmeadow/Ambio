import { useEffect, useRef, useState } from 'react'
import { reviewInboxMessage, type CanvasMessage, type WorkOrderReply } from '../store/sheetStore'
import { SheetComparison } from './SheetComparison'
import { AgentMessageContent } from './AgentMessageContent'

function ReportedResult({ reply }: { reply: WorkOrderReply }) {
  const result = reply.result
  if (!result) return <p className="axiom-inbox__evidence-empty">No structured result was attached. Review the agent’s reply and any live sheet comparison.</p>
  return <div className="axiom-inbox__reported">
    <div className="axiom-inbox__evidence-label">AGENT REPORTED · NOT INDEPENDENTLY VERIFIED</div>
    {result.commit && <p><strong>Commit</strong> <code>{result.commit}</code></p>}
    {!!result.changedFiles?.length && <div><strong>Changed files</strong><ul>{result.changedFiles.map((file, index) => <li key={`${file}:${index}`}><code>{file}</code></li>)}</ul></div>}
    {!!result.checks?.length && <div><strong>Checks</strong><ul>{result.checks.map((check, index) => <li key={index}><code>{check.command}</code> — {check.outcome}</li>)}</ul></div>}
    {!!result.remaining?.length && <div><strong>Remaining</strong><ul>{result.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
  </div>
}

export function WorkOrderReview({ message, workspaceId, sheetAvailable }: { message: CanvasMessage; workspaceId: string; sheetAvailable: boolean }) {
  const [expanded, setExpanded] = useState(!!message.reply)
  const [reopening, setReopening] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ id: string; decision: 'accepted' | 'reopened'; note: string } | null>(null)
  useEffect(() => { if (message.reply) setExpanded(true) }, [message.reply?.createdAt])
  const accepted = message.status === 'answered' && message.review?.decision === 'accepted'
  const decide = async (decision: 'accepted' | 'reopened') => {
    const note = decision === 'reopened' ? feedback.trim() : ''
    if (decision === 'reopened' && !note) { setError('Tell the agent what needs to change.'); return }
    if (!pending.current || pending.current.decision !== decision || pending.current.note !== note) pending.current = { id: crypto.randomUUID(), decision, note }
    setBusy(true); setError('')
    try {
      await reviewInboxMessage(workspaceId, message.id, pending.current.id, decision, note)
      pending.current = null; setReopening(false); setFeedback('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save review. Retry the same decision.') }
    finally { setBusy(false) }
  }
  return <section className="axiom-inbox__review" aria-label={`Work order details ${message.id}`}>
    <button type="button" className="axiom-inbox__review-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span>{expanded ? '▾' : '▸'} WORK ORDER DETAILS</span><span>{message.status === 'cancelled' ? 'Cancelled' : accepted ? 'Accepted' : message.reply ? 'Ready for review' : message.review?.decision === 'reopened' ? 'Changes requested' : 'Tracking'}</span>
    </button>
    {expanded && <div className="axiom-inbox__review-body">
      <p className="axiom-inbox__review-intent"><strong>Requested outcome</strong>{message.note}</p>
      {message.sessions?.length ? <div className="axiom-inbox__review-sessions"><strong>Linked work</strong><ul>{message.sessions.map(session => <li key={session.id}>{session.agent || 'Agent'} · {session.goal}{session.branch ? ` · ${session.branch}` : ''}{session.endedAt ? ' · ended' : ' · open'}</li>)}</ul></div> : <p className="axiom-inbox__evidence-empty">No work session has been declared for this order.</p>}
      {!!message.changes?.length && <div className="axiom-inbox__review-changes"><div className="axiom-inbox__evidence-label">AXIOM OBSERVED · LINKED ARCHITECTURE CHANGES</div><ul>{message.changes.map((change, index) => <li key={`${change.at}:${index}`}>{change.kind} · {change.subjectLabel || 'unnamed item'}{change.objectLabel ? ` → ${change.objectLabel}` : ''}{change.count > 1 ? ` (${change.count} updates)` : ''}</li>)}</ul><small>Shows indexed changes attributed to a linked session. Unattributed changes may appear only in Morning Delta.</small></div>}
      {message.reply && <ReportedResult reply={message.reply} />}
      {message.sheetId && sheetAvailable && <div className="axiom-inbox__review-sheet"><div className="axiom-inbox__evidence-label">AXIOM CHECK · CURRENT LIVE STRUCTURE</div><p>This comparison reflects the sheet and canvas now; it does not prove runtime behavior or the state at submission.</p><button type="button" className="axiom-inbox__review-compare" onClick={() => setCompareOpen(!compareOpen)}>{compareOpen ? 'Hide live comparison' : 'Check live comparison'}</button>{compareOpen && <SheetComparison workspaceId={workspaceId} sheetId={message.sheetId} />}</div>}
      {message.sheetId && !sheetAvailable && <p className="axiom-inbox__evidence-empty">The attached sheet is unavailable for a current comparison.</p>}
      {!!message.priorReplies?.length && <div className="axiom-inbox__review-prior"><strong>Earlier submissions</strong>{message.priorReplies.map((reply, index) => <details key={`${reply.createdAt}:${index}`}><summary>{reply.agent} · {new Date(reply.createdAt).toLocaleString()}</summary><AgentMessageContent text={reply.body} /><ReportedResult reply={reply} /></details>)}</div>}
      {(message.reviews?.length ?? 0) > 1 && <div className="axiom-inbox__review-history"><strong>Earlier reviews</strong><ol>{message.reviews!.slice(0, -1).map(review => <li key={review.id}>{review.decision === 'accepted' ? 'Accepted' : 'Changes requested'} · {new Date(review.createdAt).toLocaleString()}{review.note && <p>{review.note}</p>}</li>)}</ol></div>}
      {message.review?.decision === 'reopened' && <div className="axiom-inbox__review-feedback"><strong>Changes requested</strong><p>{message.review.note}</p></div>}
      {accepted && <p className="axiom-inbox__review-accepted">Accepted by you · {new Date(message.review!.createdAt).toLocaleString()}</p>}
      {message.status === 'answered' && message.reply && !accepted && <div className="axiom-inbox__review-actions">
        <p>The agent submitted an answer. Check the result before accepting it.</p>
        <button type="button" disabled={busy} onClick={() => { void decide('accepted') }}>Accept result</button>
        <button type="button" disabled={busy} onClick={() => setReopening(!reopening)}>Request changes</button>
        {reopening && <div className="axiom-inbox__review-reopen"><label htmlFor={`review-feedback-${message.id}`}>What needs to change?</label><textarea id={`review-feedback-${message.id}`} value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={4000} rows={3} /><button type="button" disabled={busy || !feedback.trim()} onClick={() => { void decide('reopened') }}>Reopen work order</button></div>}
      </div>}
      {error && <p role="alert" className="axiom-inbox__review-error">{error}</p>}
    </div>}
  </section>
}
