import { Chevron, DisclosureSummary } from './ui/Chevron'
import { useEffect, useRef, useState } from 'react'
import { useCheckoutStore, REVIEW_BRANCH } from '../store/checkoutStore'
import { checkoutName } from './checkoutModel'
import { reviewInboxMessage, type CanvasMessage, type Sheet, type WorkOrderReply } from '../store/sheetStore'
import { SheetComparison } from './SheetComparison'
import { AgentMessageContent } from './AgentMessageContent'
import { SentSheetSnapshot } from './SentSheetSnapshot'
import { SentPlanComparison } from './SentPlanComparison'

function ReportedResult({ reply }: { reply: WorkOrderReply }) {
  const result = reply.result
  if (!result || (!result.commit && !result.changedFiles?.length && !result.checks?.length && !result.remaining?.length)) return null
  return <div className="ambio-inbox__reported">
    <div className="ambio-inbox__evidence-label">Agent report <span>checks supplied by agent</span></div>
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
  return <section className="ambio-inbox__review" aria-label={`Work order details ${message.id}`}>
    <button type="button" className="ambio-inbox__review-toggle" aria-expanded={expanded} onClick={() => { if (!expanded && message.status === 'answered' && currentSheet) setCompareOpen(true); setExpanded(!expanded) }}>
      <span><Chevron expanded={expanded} /> {message.status === 'answered' && !accepted ? 'Review result' : 'Details'}</span><span>{message.sessions?.length ? `${message.sessions.length} work ${message.sessions.length === 1 ? 'session' : 'sessions'}` : message.reply?.result ? 'Agent report' : message.sheetId ? 'Sheet' : ''}</span>
    </button>
    {expanded && <div className="ambio-inbox__review-body">
      {message.sheetId && <div className="ambio-inbox__sent-sheet" data-changed={sheetChanged || undefined}>
        <strong>Sheet sent to agent</strong>
        <span>{message.sentSheetName || currentSheet?.name || 'Attached sheet'}{sentRevision > 0 ? `, revision ${sentRevision}` : ''}</span>
        {sheetChanged && <p>Current sheet is revision {currentSheet.revision}. This work order retains the sent revision {sentRevision}.</p>}
        {!currentSheet && <p>The current sheet is unavailable. The agent received its frozen context when this order was sent.</p>}
        <SentSheetSnapshot workspaceId={workspaceId} messageId={message.id} />
      </div>}
      {message.sheetId && <SentPlanComparison workspaceId={workspaceId} messageId={message.id} />}
      {message.status === 'answered' && message.reply && !accepted && <div className="ambio-inbox__review-actions">
        <button type="button" disabled={busy} onClick={() => { void decide('accepted') }}>Accept result</button>
        <button type="button" disabled={busy} onClick={() => setReopening(!reopening)}>Request changes</button>
        {reopening && <div className="ambio-inbox__review-reopen"><label htmlFor={`review-feedback-${message.id}`}>What needs to change?</label><textarea id={`review-feedback-${message.id}`} value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={4000} rows={3} /><button type="button" disabled={busy || !feedback.trim()} onClick={() => { void decide('reopened') }}>Reopen work order</button></div>}
      </div>}
      <RunBranchReview sessions={message.sessions} />
      {!!message.sessions?.length && <div className="ambio-inbox__review-sessions"><strong>Work sessions</strong><ul>{message.sessions.map(session => <li key={session.id}>
        <span className="ambio-inbox__session-goal">{session.goal || 'Untitled work'}</span>
        <span className="ambio-inbox__session-meta">{[session.agent || 'Agent', session.branch ? `on ${session.branch}` : '', session.endedAt ? 'finished' : 'still working'].filter(Boolean).join(', ')}</span>
        {session.notes.length > 0 && <ol>{session.notes.map((entry, index) => <li key={`${entry.ts}:${index}`}>{entry.text}</li>)}</ol>}{session.summary && <p>{session.summary}</p>}</li>)}</ul></div>}
      {!!message.changes?.length && <div className="ambio-inbox__review-changes"><div className="ambio-inbox__evidence-label">Map changes <span>from this work</span></div><ul>{message.changes.map((change, index) => <li key={`${change.at}:${index}`}><MapChange change={change} /></li>)}</ul></div>}
      {message.reply && <ReportedResult reply={message.reply} />}
      {message.sheetId && currentSheet && <div className="ambio-inbox__review-sheet"><div className="ambio-inbox__evidence-label">Current sheet structure <span>live canvas</span></div><button type="button" className="ambio-inbox__review-compare" onClick={() => setCompareOpen(!compareOpen)}>{compareOpen ? 'Hide comparison' : 'Compare current sheet'}</button>{compareOpen && <SheetComparison workspaceId={workspaceId} sheetId={message.sheetId} />}</div>}
      {!!message.priorReplies?.length && <div className="ambio-inbox__review-prior"><strong>Earlier submissions</strong>{message.priorReplies.map((reply, index) => <details key={`${reply.createdAt}:${index}`}><DisclosureSummary>{reply.agent}, {new Date(reply.createdAt).toLocaleString()}</DisclosureSummary><AgentMessageContent text={reply.body} /><ReportedResult reply={reply} /></details>)}</div>}
      {(message.reviews?.length ?? 0) > 1 && <div className="ambio-inbox__review-history"><strong>Earlier reviews</strong><ol>{message.reviews!.slice(0, -1).map(review => <li key={review.id}>{review.decision === 'accepted' ? 'Accepted' : 'Changes requested'}, {new Date(review.createdAt).toLocaleString()}{review.note && <p>{review.note}</p>}</li>)}</ol></div>}
      {message.review?.decision === 'reopened' && <div className="ambio-inbox__review-feedback"><strong>{message.status === 'answered' ? 'Previous feedback' : 'Changes requested'}</strong><p>{message.review.note}</p></div>}
      {accepted && <p className="ambio-inbox__review-accepted">Accepted by you, {new Date(message.review!.createdAt).toLocaleString()}</p>}
      {error && <p role="alert" className="ambio-inbox__review-error">{error}</p>}
    </div>}
  </section>
}

/** The last part of a path, which is how a person names a file. */
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** What a journal entry did to the map, as a sentence, the file by its name. */
export function mapChangeWords(change: { kind: string; subjectLabel: string; objectLabel?: string }): { lead: string; subject: string; rest: string } {
  const subject = change.subjectLabel || 'an unnamed item'
  const file = fileName(subject)
  const object = change.objectLabel ?? ''
  switch (change.kind) {
    case 'file.assigned': return { lead: 'Put', subject: file, rest: object ? `in ${object}` : 'in a system' }
    case 'file.moved': return { lead: 'Moved', subject: file, rest: object ? `to ${object}` : '' }
    case 'file.created': return { lead: 'Added', subject: file, rest: object ? `to ${object}` : '' }
    case 'file.updated': return { lead: 'Changed', subject: file, rest: '' }
    case 'file.deleted': return { lead: 'Removed', subject: file, rest: '' }
    case 'file.unclassified': return { lead: 'Left', subject: file, rest: 'unsorted' }
    case 'system.created': case 'system.added': return { lead: 'Created system', subject, rest: object ? `in ${object}` : '' }
    case 'system.renamed': return { lead: 'Renamed', subject, rest: object ? `to ${object}` : '' }
    case 'system.nested': return { lead: 'Put', subject, rest: object ? `inside ${object}` : '' }
    case 'system.merged': return { lead: 'Merged', subject, rest: object ? `into ${object}` : '' }
    case 'system.ungrouped': return { lead: 'Ungrouped', subject, rest: '' }
    case 'system.deleted': case 'system.removed': return { lead: 'Removed system', subject, rest: '' }
    case 'infra.linked': return { lead: 'Linked', subject, rest: object ? `to ${object}` : '' }
    case 'infra.unlinked': return { lead: 'Unlinked', subject, rest: object ? `from ${object}` : '' }
  }
  return { lead: 'Changed', subject, rest: object ? `(${object})` : '' }
}

function MapChange({ change }: { change: { kind: string; subjectLabel: string; objectLabel?: string; count: number } }) {
  const words = mapChangeWords(change)
  return <span title={change.subjectLabel}>{words.lead} <strong>{words.subject}</strong>{words.rest ? ` ${words.rest}` : ''}{change.count > 1 ? `, ${change.count} times` : ''}</span>
}

/**
 * A work order an agent ran on another branch - its own worktree - is
 * reviewed as that branch's architecture, and applied or discarded from the
 * branch menu (docs/GIT_AND_PROJECT_SHAPES.md stage 4).
 */
function RunBranchReview({ sessions }: { sessions?: Array<{ rootId?: string }> }) {
  const elsewhere = useCheckoutStore(state => {
    const checkouts = state.snapshot?.checkouts ?? []
    return checkouts.find(checkout => !checkout.isFocused && sessions?.some(session => session.rootId === checkout.rootId))
  })
  if (!elsewhere) return null
  const name = checkoutName(elsewhere)
  return <div className="ambio-inbox__review-branch">
    <span>Worked on <code>{name}</code>{elsewhere.isAmbioRun ? ' in its own worktree' : ''}.</span>
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(REVIEW_BRANCH, { detail: { rootId: elsewhere.rootId, name } }))}>Review this branch</button>
  </div>
}
