import { Chevron, DisclosureSummary } from './ui/Chevron'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { DeliveryEvent, DeliveryHost, DeliveryRun } from '../../shared/agentDelivery'
import type { ChatPart } from '../../shared/agentChat'
import { AgentMessageContent } from './AgentMessageContent'
import { InboxIcon } from './InboxIcon'
import { inputSummary, isGenericTool, projectPath, statusLabel, STEP_VERBS, stepsSummary, toolActivityLabel, toolRow, toolWords } from './agentActivity'
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
  /** What a tool was asked, where it says more than the row. */
  input?: string
  output?: string
  diff?: string
  /** Map nodes the step touched, when known, so it can show them. */
  targets?: string[]
  /** Still being written; the caret follows it. */
  live?: boolean
}

/**
 * How a step shows the map nodes it touched. Provided where there is a map
 * (the agent panel); without it, as in setup, steps offer no map link.
 */
export const StepTargetsContext = createContext<((nodeIds: string[]) => void) | null>(null)

// A tool call that failed used to be reported as an error of its own, its
// label shown raw outside the steps; it is the failed step it always was.
export const deliveryWorkItems = (events: DeliveryEvent[]): WorkItem[] =>
  events.map((event, index) => {
    const failedTool = event.kind === 'error' && !!event.id
    return { key: event.id ?? `${event.at}:${index}`, kind: failedTool ? 'tool' : event.kind, text: event.text, status: failedTool ? event.status ?? 'failed' : event.status, exitCode: event.exitCode, input: event.input, output: event.output, diff: event.diff, live: event.live }
  })

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

/** A run of steps between two things the agent said: its thinking and tool calls. */
type WorkBlock = { kind: 'said'; item: WorkItem } | { kind: 'steps'; key: string; items: WorkItem[] }

function workBlocks(items: WorkItem[]): WorkBlock[] {
  const blocks: WorkBlock[] = []
  for (const item of items) {
    const last = blocks.at(-1)
    if (item.kind === 'thinking' || item.kind === 'tool') {
      if (last?.kind === 'steps') last.items.push(item)
      else blocks.push({ kind: 'steps', key: `steps:${item.key}`, items: [item] })
    } else blocks.push({ kind: 'said', item })
  }
  return blocks
}

/**
 * What the agent said and did, in order. What it says to the person stays in
 * front; the steps between (thinking, tool calls) fold into one line each run
 * that opens to show every one in full. While it works, the run under way is
 * open so the person can follow it.
 */
export function AgentWork({ items, rootPath, working }: { items: WorkItem[]; rootPath?: string; working?: boolean }) {
  if (!items.length) return null
  const blocks = workBlocks(items)
  return <ol className="ambio-inbox__activity ambio-turn__work" aria-label="What the agent is doing">
    {blocks.map((block, index) => block.kind === 'steps'
      ? <li key={block.key} data-kind="steps"><AgentSteps items={block.items} rootPath={rootPath} current={!!working && index === blocks.length - 1} /></li>
      : <li key={block.item.key} data-kind={block.item.kind} data-live={block.item.live ? 'true' : undefined}>
        {block.item.kind === 'text' ? <AgentMessageContent text={block.item.text} />
          : block.item.kind === 'sent' ? <p><small>You</small>{block.item.text}</p>
            : <p>{toolActivityLabel(projectPath(block.item.text, rootPath))}</p>}
      </li>)}
  </ol>
}

/** One run of steps: a summary line, and every step in full beneath it. */
function AgentSteps({ items, rootPath, current }: { items: WorkItem[]; rootPath?: string; current: boolean }) {
  // Follows the turn (open while it is the run under way) until the person opens or closes it.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? current
  return <div className="ambio-turn__steps" data-open={open ? 'true' : undefined} data-current={current ? 'true' : undefined}>
    <button type="button" className="ambio-turn__steps-toggle" aria-expanded={open} onClick={() => setChosen(!open)}>
      <Chevron size={11} expanded={open} />
      <span>{stepsSummary(items)}</span>
    </button>
    <ol className="ambio-turn__step-list" hidden={!open}>
      {items.map(item => <li key={item.key} data-kind={item.kind}>
        {item.kind === 'thinking'
          ? <div className="ambio-turn__thinking"><span>Thinking</span><p>{item.text}</p></div>
          : <ToolLine item={item} rootPath={rootPath} />}
      </li>)}
    </ol>
  </div>
}

const FILE_STEPS = new Set(['Read', 'Edit', 'List'])

/** A path's last part and the folder before it, or nothing when it is not a path. */
function splitPath(path: string): { name: string; folder: string } | undefined {
  // A command ("sed -n 1,5p src/a.ts") is not a path.
  if (/\s-\w/.test(path)) return undefined
  const match = /^(.*[\\/])([^\\/]+)$/.exec(path.trim())
  if (!match || /\s/.test(match[2]) && !/\.\w+$/.test(match[2])) return undefined
  return { name: match[2], folder: match[1].replace(/[\\/]+$/, '') || match[1] }
}

/** A name without its leading verb ("Edit a.ts" under Edit reads "a.ts"), unless that is all it is. */
function withoutVerb(name: string, verb: string): string {
  const match = /^(\S+)\s+(\S.*)$/.exec(name)
  return match && match[1].toLowerCase().startsWith(verb.toLowerCase()) ? match[2] : name
}

/** Duplicate parts of a row: agy names the same file twice, once relative and once absolute. */
function sameFile(a: string, b: string): boolean {
  const last = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase() ?? ''
  return /\./.test(last(a)) && last(a) === last(b)
}

/**
 * One step: the word for what it did, then what it acted on, said once.
 * Nothing is shown for a step that finished; one still going says so, and
 * one that failed says how. A step with more to it (what it was asked, what
 * came back, what it changed) opens in place.
 */
function ToolLine({ item, rootPath }: { item: WorkItem; rootPath?: string }) {
  const [open, setOpen] = useState(false)
  const row = toolRow(item.text, rootPath)
  const status = item.status ? statusLabel(item.status) : undefined
  // Drivers join a row's parts with a separator; each part is its own piece here.
  const parts = [row.tool, ...(row.target ? row.target.split(' \u00b7 ') : [])].map(part => part.trim()).filter(Boolean)
  const said = parts.filter((part, index) => !parts.slice(0, index).some(earlier => earlier === part || sameFile(earlier, part)))
  // "Bash", "Read", "Shell" only repeat the step's word; their target says what it did.
  const verb = STEP_VERBS[row.badge]
  const named = (row.badge === 'Ambio' ? [toolWords(row.tool), ...said.slice(1)]
    : said.length > 1 && isGenericTool(said[0]) ? said.slice(1) : said)
    // "Edit fixture.txt", "Reading src/app.ts": the leading word is the step's own.
    .map((part, index) => index === 0 && row.badge !== 'Ambio' && row.badge !== 'Tool' ? withoutVerb(part, verb) : part)
  // A file is named by its name; the folder it is in follows, quieter, so a
  // narrow panel still shows which file it was.
  const file = named.length === 1 && FILE_STEPS.has(row.badge) ? splitPath(named[0]) : undefined
  const name = file ? file.name : named[0] ?? row.tool
  const about = file ? file.folder : named.length > 1 ? named.slice(1).join(', ') : row.badge === 'Ambio' ? inputSummary(item.input) : ''
  const failed = status === 'failed' || status === 'declined' || status === 'error' || (item.exitCode != null && item.exitCode !== 0)
  const state = failed ? (item.exitCode != null && item.exitCode !== 0 ? `failed, exit ${item.exitCode}` : status === 'declined' ? 'declined' : 'failed')
    : status === 'running' || status === 'waiting' ? status : ''
  const showTargets = useContext(StepTargetsContext)
  const targets = showTargets && item.targets?.length ? item.targets : undefined
  const more = !!(item.input || item.output || item.diff || targets)
  const line = <>
    <span className="ambio-turn__verb" data-badge={row.badge.toLowerCase()}>{verb}</span>
    <span className="ambio-turn__what">
      {row.subagent !== undefined && <span className="ambio-turn__subagent" title="Done by a subagent">{row.subagent || 'Subagent'}</span>}
      <span className="ambio-turn__tool-name" title={file ? named[0] : undefined}>{name}</span>
      {about && <span className="ambio-turn__target" title={about}>{about}</span>}
    </span>
    {state && <span className="ambio-turn__state" data-failed={failed || undefined}>{state}</span>}
  </>
  if (!more) return <div className="ambio-turn__tool"><span className="ambio-turn__chevron-space" aria-hidden="true" />{line}</div>
  return <div className="ambio-turn__tool-item" data-open={open || undefined}>
    <button type="button" className="ambio-turn__tool" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Chevron size={10} expanded={open} />{line}
    </button>
    {open && <div className="ambio-turn__tool-detail">
      {item.input && <section><h4>Asked</h4><pre>{item.input}</pre></section>}
      {item.diff && <section><h4>Changes</h4><pre>{item.diff}</pre></section>}
      {item.output && <section><h4>{failed ? 'Error' : 'Answer'}</h4><pre>{item.output}</pre></section>}
      {targets && <button type="button" className="ambio-turn__show-targets" onClick={() => showTargets!(targets)}>
        Show on map{targets.length > 1 ? ` (${targets.length})` : ''}
      </button>}
    </div>}
  </div>
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
      {working && <span className="ambio-turn__working" role="status">{took ? `Working for ${took}` : 'Working'}</span>}
      {answer?.onCopy && !working && <button type="button" className="ambio-inbox__copy-reply" aria-label={answer.copied ? 'Reply copied' : 'Copy reply'} onClick={answer.onCopy}><InboxIcon name={answer.copied ? 'check' : 'copy'} size={13} />{answer.copied ? 'Copied' : 'Copy'}</button>}
    </div>
    {folded
      ? (work.length > 0 || footer) && <details className="ambio-turn__fold"><DisclosureSummary>{summary}</DisclosureSummary><AgentWork items={work} rootPath={rootPath} />{footer && <div className="ambio-turn__footer">{footer}</div>}</details>
      : <>
        <AgentWork items={work} rootPath={rootPath} working={working} />
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
