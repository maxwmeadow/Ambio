import { useEffect, useState, type ReactNode } from 'react'
import type { DeliveryEvent, DeliveryHost, DeliveryRun } from '../../shared/agentDelivery'
import type { ChatPart } from '../../shared/agentChat'
import { AgentMessageContent } from './AgentMessageContent'
import { InboxIcon } from './InboxIcon'
import { projectPath, statusLabel, toolRow } from './agentActivity'
import '../styles/agentTurn.css'

/**
 * One agent turn in the conversation, the same for every agent: while it
 * works, what it says and does streams into the card its answer will fill;
 * once it answers, that work folds into a "Worked for …" disclosure above the
 * answer (DECISIONS 2026-11-06). Delivery runs and Ambio chat both render
 * through it, so no agent's turn reads as a report from somewhere else.
 */

/** One thing an agent said or did, whichever kind of agent it was. */
export interface WorkItem {
  key: string
  kind: 'text' | 'thinking' | 'tool' | 'error' | 'sent'
  text: string
  status?: string
  exitCode?: number | null
  output?: string
  diff?: string
  /** Still being written; the caret follows it. */
  live?: boolean
}

export const deliveryWorkItems = (events: DeliveryEvent[]): WorkItem[] =>
  events.map((event, index) => ({ key: event.id ?? `${event.at}:${index}`, kind: event.kind, text: event.text, status: event.status, exitCode: event.exitCode, output: event.output, diff: event.diff, live: event.live }))

export const chatWorkItems = (parts: ChatPart[]): WorkItem[] =>
  parts.map(part => part.kind === 'tool'
    ? { key: part.id, kind: 'tool', text: part.tool ?? 'Tool', status: part.state, output: part.text }
    : { key: part.id, kind: part.kind === 'reasoning' ? 'thinking' : 'text', text: part.text })

/** A duration as a person says it: "40s", "3 min", "1 h 5 min". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** What the agent said and did, in order, styled like the conversation around it. */
export function AgentWork({ items, rootPath }: { items: WorkItem[]; rootPath?: string }) {
  if (!items.length) return null
  return <ol className="ambio-inbox__activity ambio-turn__work" aria-label="What the agent is doing">
    {items.map(item => <li key={item.key} data-kind={item.kind} data-live={item.live ? 'true' : undefined}>
      {item.kind === 'text' ? <AgentMessageContent text={item.text} />
        : item.kind === 'thinking' ? <p>{item.text}</p>
          : item.kind === 'sent' ? <p><small>You</small>{item.text}</p>
            : item.kind === 'error' ? <p>{projectPath(item.text, rootPath)}</p>
              : <ToolLine item={item} rootPath={rootPath} />}
    </li>)}
  </ol>
}

function ToolLine({ item, rootPath }: { item: WorkItem; rootPath?: string }) {
  const row = toolRow(item.text, rootPath)
  const status = item.status ? statusLabel(item.status) : undefined
  // Drivers join a row's parts with " · "; here each part is its own piece, set apart by space and weight.
  const targets = row.target ? row.target.split(' · ').filter(Boolean) : []
  const line = <span className="ambio-turn__tool">
    <span className="ambio-turn__tool-state" data-status={status} aria-hidden="true" />
    <span className="ambio-turn__badge" data-badge={row.badge.toLowerCase()}>{row.badge}</span>
    {row.subagent !== undefined && <span className="ambio-turn__subagent" title="Done by a subagent">{row.subagent || 'Subagent'}</span>}
    <span className="ambio-turn__tool-name">{row.tool}</span>
    {targets.map((target, index) => <span key={index} className="ambio-turn__target" title={target}>{target}</span>)}
    {status && <small>{status}{item.exitCode != null ? `, exit ${item.exitCode}` : ''}</small>}
    {(item.output || item.diff) && <span className="ambio-turn__more">{item.diff ? 'View changes' : 'View output'}</span>}
  </span>
  return item.output || item.diff
    ? <details><summary>{line}</summary><pre>{item.diff || item.output}</pre></details>
    : line
}

/**
 * The turn's card: the agent's name, then its work streaming while it works,
 * folded away once it answers, then the answer. `footer` follows the work
 * (usage, the run's output); `status` says how a turn without an answer ended.
 */
export function AgentTurnCard({ agent, working, startedAt, lastAt, items, rootPath, answer, status, footer, actions, className }: {
  agent: string
  className?: string
  working: boolean
  startedAt?: number
  /** The latest sign of life, for how long the work took. */
  lastAt?: number
  items: WorkItem[]
  rootPath?: string
  /** The agent's answer; its work folds away above it. */
  answer?: { text: string; onCopy?: () => void; copied?: boolean }
  status?: ReactNode
  footer?: ReactNode
  actions?: ReactNode
}) {
  // A clock, so a long turn reads as alive or as stuck instead of as nothing.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [working])
  // The answer is said once: the closing text that repeats it stays out of the folded work.
  const work = answer && items.at(-1)?.kind === 'text' && items.at(-1)!.text.trim() === answer.text.trim() ? items.slice(0, -1) : items
  const steps = work.filter(item => item.kind === 'tool').length
  const took = startedAt ? elapsed((working ? now : lastAt ?? startedAt) - startedAt) : ''
  const summary = [took ? `Worked for ${took}` : 'Work', steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : ''].filter(Boolean).join(', ')
  const folded = !working && !!answer
  return <section className={`ambio-inbox__reply ambio-turn${className ? ` ${className}` : ''}`} data-state={working ? 'working' : answer ? 'answered' : 'ended'} aria-label={`${agent}${working ? ' working' : ''}`}>
    <div className="ambio-inbox__reply-heading">
      <InboxIcon name="agent" size={16} /><strong>{agent}</strong>
      {working && <span className="ambio-turn__working" role="status"><span className="ambio-turn__pulse" aria-hidden="true" />{took ? `Working for ${took}` : 'Working'}</span>}
      {answer?.onCopy && !working && <button type="button" className="ambio-inbox__copy-reply" aria-label={answer.copied ? 'Reply copied' : 'Copy reply'} onClick={answer.onCopy}><InboxIcon name={answer.copied ? 'check' : 'copy'} size={13} />{answer.copied ? 'Copied' : 'Copy'}</button>}
    </div>
    {folded
      ? (work.length > 0 || footer) && <details className="ambio-turn__fold"><summary>{summary}</summary><AgentWork items={work} rootPath={rootPath} />{footer && <div className="ambio-turn__footer">{footer}</div>}</details>
      : <>
        <AgentWork items={work} rootPath={rootPath} />
        {working && !work.length && <p className="ambio-turn__starting">Starting…</p>}
        {working && lastAt && now - lastAt > 60000 && <p className="ambio-turn__quiet">Nothing new for {elapsed(now - lastAt)}. Long commands and background tasks can take a while; Stop if it should be done by now.</p>}
        {status && <p className="ambio-inbox__turn-status" data-state="ended">{status}</p>}
        {(footer || actions) && <div className="ambio-turn__footer">{actions}{footer}</div>}
      </>}
    {answer && <AgentMessageContent text={answer.text} />}
  </section>
}

/**
 * A turn an agent Ambio started answers: its run's events streaming in while
 * it works, then folded above the reply. Without a run (an agent outside
 * Ambio replied) it is just the reply.
 */
export function AgentRunTurn({ run, hosts, events = [], reply, onRetry, onCopy, copied }: {
  run?: DeliveryRun; hosts: DeliveryHost[]; events?: DeliveryEvent[]
  reply?: { agent: string; body: string }
  onRetry?: () => void; onCopy?: () => void; copied?: boolean
}) {
  const hostId = run?.hostId ?? reply?.agent ?? ''
  const label = hosts.find(host => host.id === hostId)?.label ?? reply?.agent ?? hostId
  const working = !!run && (run.state === 'starting' || run.state === 'running' || run.state === 'stopping')
  const lastAt = run ? events.reduce((latest, event) => Math.max(latest, event.at), run.startedAt) : undefined
  const ended = run && !working && !reply
    ? run.state === 'stopped' ? `${label} was stopped.`
      : run.state === 'completed' ? `${label} finished without replying.`
        : `${label} stopped without an answer.`
    : undefined
  const footer = run && <>
    {run.usage && <small>{run.usage.scope === 'thread' ? 'Thread total: ' : ''}{run.usage.inputTokens.toLocaleString()} input, {run.usage.outputTokens.toLocaleString()} output tokens{run.usage.cachedInputTokens ? `, ${run.usage.cachedInputTokens.toLocaleString()} cached` : ''}</small>}
    {/* The raw log is for after the fact; while it works, the stream is the output. */}
    {!working && <button type="button" className="ambio-inbox__turn-link" onClick={() => window.ambio.showInFolder(run.logPath)}>Show output</button>}
  </>
  return <AgentTurnCard agent={label} working={working} startedAt={run?.startedAt} lastAt={lastAt} items={deliveryWorkItems(events)} rootPath={run?.rootPath}
    answer={reply ? { text: reply.body, onCopy, copied } : undefined} status={ended} footer={footer}
    actions={!working && !reply && onRetry ? <button type="button" className="ambio-inbox__turn-action" onClick={onRetry}>Try again</button> : undefined} />
}
