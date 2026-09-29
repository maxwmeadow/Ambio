import { useEffect, useRef, useState } from 'react'
import { reviewInboxMessage, type CanvasMessage, type Sheet, type WorkOrderReply } from '../store/sheetStore'
import { SheetComparison } from './SheetComparison'
import { AgentMessageContent } from './AgentMessageContent'
import { SentSheetSnapshot } from './SentSheetSnapshot'
import { SentPlanComparison } from './SentPlanComparison'

function ReportedResult({ reply }: { reply: WorkOrderReply }) {
  const result = reply.result
  if (!result || (!result.commit && !result.changedFiles?.length && !result.checks?.length && !result.remaining?.length)) return null
  return <div className="axiom-inbox__reported">
    <div className="axiom-inbox__evidence-label">Agent report <span>· checks supplied by agent</span></div>
    {result.commit && <p><strong>Commit</strong> <code>{result.commit}</code></p>}
    {!!result.changedFiles?.length && <div><strong>Changed files</strong><ul>{result.changedFiles.map((file, index) => <li key={`${file}:${index}`}><code>{file}</code></li>)}</ul></div>}
    {!!result.checks?.length && <div><strong>Checks</strong><ul>{result.checks.map((check, index) => <li key={index}><code>{check.command}</code> — {check.outcome}</li>)}</ul></div>}
    {!!result.remaining?.length && <div><strong>Remaining</strong><ul>{result.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
  </div>
}

export function WorkOrderReview({ message, workspaceId, currentSheet }: { message: CanvasMessage; workspaceId: string; currentSheet?: Sheet }) {
  const [expanded, setExpanded] = useState(message.status !== 'answered' && message.review?.decision === 'reopened')
  const [reopening, setReopening] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ id: string; decision: 'accepted' | 'reopened'; note: string } | null>(null)
  useEffect(() => {
    if (message.status === 'answered') setExpanded(false)
    else if (message.review?.decision === 'reopened') setExpanded(true)
  }, [message.review?.id, message.status])
  const accepted = message.status === 'answered' && message.review?.decision === 'accepted'
  const sentRevision = message.sentSheetRevision ?? 0
  const sheetChanged = !!currentSheet && sentRevision > 0 && currentSheet.revision !== sentRevision
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
  const hasDetails = !!(message.sessions?.length || message.changes?.length || message.reply?.result || message.sheetId || message.priorReplies?.length || message.review?.decision === 'reopened' || message.status === 'answered' && !accepted && message.reply)
  if (!hasDetails) return null
  return <section className="axiom-inbox__review" aria-label={`Work order details ${message.id}`}>
    <button type="button" className="axiom-inbox__review-toggle" aria-expanded={expanded} onClick={() => { if (!expanded && message.status === 'answered' && currentSheet) setCompareOpen(true); setExpanded(!expanded) }}>
      <span>{expanded ? '▾' : '▸'} {message.status === 'answered' && !accepted ? 'Review result' : 'Details'}</span><span>{message.sessions?.length ? `${message.sessions.length} work ${message.sessions.length === 1 ? 'session' : 'sessions'}` : message.reply?.result ? 'Agent report' : message.sheetId ? 'Sheet' : ''}</span>
    </button>
    {expanded && <div className="axiom-inbox__review-body">
      {message.sheetId && <div className="axiom-inbox__sent-sheet" data-changed={sheetChanged || undefined}>
        <strong>Sheet sent to agent</strong>
        <span>{message.sentSheetName || currentSheet?.name || 'Attached sheet'}{sentRevision > 0 ? ` · revision ${sentRevision}` : ''}</span>
        {sheetChanged && <p>Current sheet is revision {currentSheet.revision}. This work order retains the sent revision {sentRevision}.</p>}
        {!currentSheet && <p>The current sheet is unavailable. The agent received its frozen context when this order was sent.</p>}
        <SentSheetSnapshot workspaceId={workspaceId} messageId={message.id} />
      </div>}
      {message.sheetId && <SentPlanComparison workspaceId={workspaceId} messageId={message.id} />}
      {message.status === 'answered' && message.reply && !accepted && <div className="axiom-inbox__review-actions">
        <button type="button" disabled={busy} onClick={() => { void decide('accepted') }}>Accept result</button>
        <button type="button" disabled={busy} onClick={() => setReopening(!reopening)}>Request changes</button>
        {reopening && <div className="axiom-inbox__review-reopen"><label htmlFor={`review-feedback-${message.id}`}>What needs to change?</label><textarea id={`review-feedback-${message.id}`} value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={4000} rows={3} /><button type="button" disabled={busy || !feedback.trim()} onClick={() => { void decide('reopened') }}>Reopen work order</button></div>}
      </div>}
      {!!message.sessions?.length && <div className="axiom-inbox__review-sessions"><strong>Work sessions</strong><ul>{message.sessions.map(session => <li key={session.id}><span>{session.agent || 'Agent'} · {session.goal}{session.branch ? ` · ${session.branch}` : ''}{session.endedAt ? ' · ended' : ' · open'}</span>{session.notes.length > 0 && <ol>{session.notes.map((entry, index) => <li key={`${entry.ts}:${index}`}>{entry.text}</li>)}</ol>}{session.summary && <p>{session.summary}</p>}</li>)}</ul></div>}
      {!!message.changes?.length && <div className="axiom-inbox__review-changes"><div className="axiom-inbox__evidence-label">Indexed changes <span>· linked to this order</span></div><ul>{message.changes.map((change, index) => <li key={`${change.at}:${index}`}>{change.kind} · {change.subjectLabel || 'unnamed item'}{change.objectLabel ? ` → ${change.objectLabel}` : ''}{change.count > 1 ? ` (${change.count} updates)` : ''}</li>)}</ul></div>}
      {message.reply && <ReportedResult reply={message.reply} />}
      {message.sheetId && currentSheet && <div className="axiom-inbox__review-sheet"><div className="axiom-inbox__evidence-label">Current sheet structure <span>· live canvas</span></div><button type="button" className="axiom-inbox__review-compare" onClick={() => setCompareOpen(!compareOpen)}>{compareOpen ? 'Hide comparison' : 'Compare current sheet'}</button>{compareOpen && <SheetComparison workspaceId={workspaceId} sheetId={message.sheetId} />}</div>}
      {!!message.priorReplies?.length && <div className="axiom-inbox__review-prior"><strong>Earlier submissions</strong>{message.priorReplies.map((reply, index) => <details key={`${reply.createdAt}:${index}`}><summary>{reply.agent} · {new Date(reply.createdAt).toLocaleString()}</summary><AgentMessageContent text={reply.body} /><ReportedResult reply={reply} /></details>)}</div>}
      {(message.reviews?.length ?? 0) > 1 && <div className="axiom-inbox__review-history"><strong>Earlier reviews</strong><ol>{message.reviews!.slice(0, -1).map(review => <li key={review.id}>{review.decision === 'accepted' ? 'Accepted' : 'Changes requested'} · {new Date(review.createdAt).toLocaleString()}{review.note && <p>{review.note}</p>}</li>)}</ol></div>}
      {message.review?.decision === 'reopened' && <div className="axiom-inbox__review-feedback"><strong>{message.status === 'answered' ? 'Previous feedback' : 'Changes requested'}</strong><p>{message.review.note}</p></div>}
      {accepted && <p className="axiom-inbox__review-accepted">Accepted by you · {new Date(message.review!.createdAt).toLocaleString()}</p>}
      {error && <p role="alert" className="axiom-inbox__review-error">{error}</p>}
    </div>}
  </section>
}
