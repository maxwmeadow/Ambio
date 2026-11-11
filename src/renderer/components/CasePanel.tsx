import { Chevron, DisclosureSummary } from './ui/Chevron'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type InvestigationDoc, type ReplayState } from '../store/graphStore'
import { apiGetInvestigation } from '../canvas/arcdApi'
import { AgentMessageContent } from './AgentMessageContent'
import { splitInlineNumberedLists } from './agentMessageFormat'
import { useShowOnMap } from '../canvas/useShowOnMap'
import {
  caseSummary,
  caseSteps,
  emptyCase,
  type CaseStep,
  type CaseAnchor,
  type CaseFile,
  type CaseFinding,
  type CaseRun,
} from '../store/caseFile'

/**
 * The case panel: an agent's investigation, as the person watching sees it.
 *
 * It exists because the canvas alone could not answer "what is my agent
 * doing?". In a trial the only live signal was a timer in the toolbar while
 * the agent had already named the root cause. Here the case reads as it
 * develops: what is suspected, what each experiment actually showed, which
 * suspicion held up, and what the root cause is. Every file or function it
 * names is a button that takes the map there, and the watcher can talk back -
 * a message reaches the agent with its next step.
 */

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Finding text uses `code` spans; render them as code. */
function Rich({ text }: { text: string }) {
  const parts = text.split('`')
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  )
}

/** The agent's wording, drawn as the chat draws it: Markdown, lists, code and
 * file chips. Never invent a summary or silently replace earlier cards with a
 * later assessment. */
function StepText({ text }: { text: string }) {
  return <div className="ambio-case__prose"><AgentMessageContent text={splitInlineNumberedLists(text.trim())} /></div>
}

function useFocus() {
  const showOnMap = useShowOnMap(false, {duration:300, maxZoom:1.2, padding:.5})
  return (anchor?: CaseAnchor) => {
    if (anchor?.fileId) showOnMap(anchor.fileId)
  }
}

function AnchorChips({ anchors }: { anchors?: CaseAnchor[] }) {
  const focus = useFocus()
  if (!anchors?.length) return null
  // One destination, one label. The symbol is context, not a second filename.
  const unique = anchors.filter((a, index) => anchors.findIndex(other => (other.fileId || other.relPath) === (a.fileId || a.relPath) && other.symbol === a.symbol) === index)
  return <div className="ambio-case__anchors" aria-label="Referenced code">
    {unique.map((a, i) => <button key={`${a.fileId}-${a.symbol}-${i}`} type="button" className="ambio-case__anchor" disabled={!a.fileId}
      title={a.relPath ? `Show ${a.relPath}${a.symbol ? `, ${a.symbol}` : ''} on the map` : 'Show referenced code on the map'} onClick={() => focus(a)}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
      <span>{basename(a.relPath) || a.symbol || 'Referenced file'}{a.symbol && basename(a.relPath) && a.symbol.toLowerCase() !== basename(a.relPath).replace(/\.[^.]+$/, '').toLowerCase() && <small>{a.symbol}</small>}</span>
      <span aria-hidden="true">↗</span>
    </button>)}
  </div>
}

function basename(path?: string): string {
  if (!path) return ''
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

function FindingRow({ finding }: { finding: CaseFinding }) {
  const focus = useFocus()
  const clickable = !!finding.anchor?.fileId
  return (
    <li className="ambio-case__finding" data-severity={finding.severity}>
      <button type="button" disabled={!clickable} onClick={() => focus(finding.anchor)} title={clickable ? 'Show on the map' : undefined}>
        <span className="ambio-case__finding-mark" aria-hidden="true">{finding.severity === 'high' ? '!' : ''}</span>
        <span className="ambio-case__finding-text"><Rich text={finding.text} /></span>
      </button>
    </li>
  )
}

function RunCard({ run }: { run: CaseRun }) {
  const findings = run.findings
  const failed = run.timedOut || run.exitCode !== 0 || !!run.error
  return (
    <details className="ambio-case__run" data-failed={failed || undefined}>
      <DisclosureSummary>
        <span className="ambio-case__run-title">Inspect evidence</span>
        <span className="ambio-case__run-meta">{findings.length ? `${findings.length} findings` : run.watched.length ? `${run.watched.length} watched` : 'Command output'}</span>
      </DisclosureSummary>
      <div className="ambio-case__run-detail">
        <code className="ambio-case__command">{run.command}</code>
        {run.error && <p className="ambio-case__run-error">{run.error}</p>}
        {findings.length > 0 ? (
          <ul className="ambio-case__findings" aria-label={`What run R${run.n} showed`}>
            {findings.map((f, i) => <FindingRow key={i} finding={f} />)}
          </ul>
        ) : !run.error && <p className="ambio-case__run-quiet">{run.watched.length
          ? 'No unusual behavior reported in the watched functions.'
          : 'Command output recorded; no watched-function evidence.'}</p>}
        {!!run.functionsRun && <p className="ambio-case__run-meta">{run.functionsRun} functions ran in {run.filesRun ?? 0} files</p>}
        {run.watched.length > 0 && <ul className="ambio-case__watched">
          {run.watched.map((w, i) => <li key={i}>
            <AnchorChips anchors={[w.anchor]} />
            <span>{w.calls} calls{w.errors ? `, ${w.errors} threw` : ''}</span>
            {w.returns && <p>Returns: <code>{w.returns}</code></p>}
            {w.samples?.length ? <details><DisclosureSummary>Sample calls ({w.samples.length})</DisclosureSummary>
              {w.samples.map((sample, n) => <pre key={n}>{`Call ${sample.call}\nArguments: ${sample.args}${sample.returned ? `\nReturned: ${sample.returned}` : ''}${sample.threw ? `\nThrew: ${sample.threw}` : ''}${sample.mutated?.length ? `\nChanged: ${sample.mutated.join(', ')}` : ''}`}</pre>)}
            </details> : null}
          </li>)}
        </ul>}
        {run.outputTail && <details className="ambio-case__output"><DisclosureSummary>Program output</DisclosureSummary><pre>{run.outputTail}</pre></details>}
      </div>
    </details>
  )
}

function StepIcon({ kind }: { kind: CaseStep['kind'] }) {
  const path = kind === 'fix' ? 'm5 12 4 4 10-10 M5 3h14v18H5z'
    : kind === 'run' || kind === 'running' ? 'm9 7 8 5-8 5z M4 3h16v18H4z'
    : kind === 'conclusion' || kind === 'verdict' ? 'm5 12 4 4 10-10 M4 3h16v18H4z'
    : 'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5'
  return <svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>
}

function StepContent({ step, file, steps, now, navigate }: { step: CaseStep; file: CaseFile; steps: readonly CaseStep[]; now: number; navigate: (id: string) => void }) {
  const question = step.hypothesisId ? steps.find(s => s.kind === 'hypothesis' && s.hypothesisId === step.hypothesisId) : undefined
  const verified = file.conclusion?.verified ? file.runs.find(run => run.id === file.conclusion?.verified) : undefined
  const linkedRun = verified ?? file.runs.at(-1)
  const evidence = linkedRun ? steps.find(s => s.run?.id === linkedRun.id) : undefined
  const message = file.messages.find(m => m.id === step.messageId)
  return <>
    <div className="ambio-case__step-heading">
      <span className="ambio-case__step-icon"><StepIcon kind={step.kind} /></span>
      <div><span className="ambio-case__entry-label">{step.label}</span><h2>{step.title}</h2></div>
    </div>
    <div className="ambio-case__step-content">
      {step.kind === 'running' ? <>
        <p className="ambio-case__experiment-state"><span className="ambio-case__live-dot" aria-hidden="true" />{file.status === 'replay' ? 'Recorded command' : `Running experiment, ${elapsed(now - (file.running?.startedAt ?? now))}`}</p>
        <code className="ambio-case__command">{step.text}</code>
      </> : step.text && !(step.run && /^Ran \d+ functions? in \d+ files?\.?$/i.test(step.text)) && <StepText text={step.text} />}
      {step.run && <>
        <p className="ambio-case__result" data-failed={!!step.run.error || step.run.timedOut || step.run.exitCode !== 0}>
          <strong>{step.run.error ? 'Not started' : step.run.timedOut ? 'Timed out' : `Exit ${step.run.exitCode}`}</strong><span>{duration(step.run.durationMs)}</span>
          {question && <button type="button" className="ambio-case__related" onClick={() => navigate(question.id)}>Tests {step.hypothesisId}<span aria-hidden="true">↗</span></button>}
        </p>
        <RunCard run={step.run} />
      </>}
      {step.recordedDetails != null && <details className="ambio-case__output"><DisclosureSummary>Recorded details</DisclosureSummary><pre>{JSON.stringify(step.recordedDetails,null,2)}</pre></details>}
      <AnchorChips anchors={step.anchors} />
      {step.kind === 'message' && <p className="ambio-case__delivery">{message?.deliveredAt ? 'Delivered to the investigating agent' : file.status === 'live' ? 'Queued for the next investigation step' : file.status === 'replay' ? 'Queued at this step' : 'Not delivered'}</p>}
      {step.kind === 'conclusion' && <div className="ambio-case__outcome">
        {!evidence && <span>Agent conclusion, no experiment recorded</span>}
        {evidence && <button type="button" className="ambio-case__text-button" onClick={() => navigate(evidence.id)}>Review experiment R{linkedRun!.n} →</button>}
      </div>}
      {step.kind === 'fix' && <div className="ambio-case__outcome" data-verified={!!verified}>
        <strong>{verified ? `Fix verified by R${verified.n}` : 'No fix verification recorded'}</strong>
        {verified && evidence && <button type="button" className="ambio-case__text-button" onClick={() => navigate(evidence.id)}>Review verification →</button>}
      </div>}
    </div>
  </>
}

/** Only explicit pause or step navigation disables following. Resume advances
 * queued work immediately, then preserves a reading interval between arrivals. */
function CaseCarousel({ file, now, replay, onDismiss, action, error }: {
  file: CaseFile; now: number; replay: ReplayState | null; onDismiss: () => void; action: React.ReactNode; error: string | null
}) {
  const steps = useMemo(() => replay ? replay.frames.map(frame => frame.step) : caseSteps(file), [file, replay?.frames])
  const [cursor, setCursor] = useState(() => ({id:steps.at(-1)?.id ?? 'opening', index:Math.max(0,steps.length - 1), following:true}))
  const [indexOpen, setIndexOpen] = useState(false)
  const [leaving, setLeaving] = useState<{step:CaseStep; file:CaseFile} | null>(null)
  const [direction, setDirection] = useState('forward')
  const selected = steps.findIndex(step => step.id === cursor.id)
  const index = replay ? replay.frameCursor : selected < 0 ? Math.min(cursor.index, steps.length - 1) : selected
  const step = steps[index] ?? {...caseSteps(emptyCase(file.id,file.name,'replay'))[0], title:'Beginning of the recording',label:'Replay',text:replay?.events.length ? 'Choose a recorded step or press Play to follow the investigation.' : 'This recording contains no recorded events.'}
  const stepFile = replay?.frames[index]?.file ?? file
  const previous = useRef({step, file:stepFile, index})
  const lastAdvance = useRef(Date.now())
  const body = useRef<HTMLDivElement>(null)
  const pending = steps.length - index - 1
  const reading = !cursor.following || indexOpen
  const following = replay ? replay.playing : cursor.following
  const dotStart = Math.max(0, Math.min(index - 3, steps.length - 7))
  const pause = () => {
    if (replay) useGraphStore.getState().setReplayPlaying(false)
    else setCursor(value => value.following ? {...value, following:false} : value)
  }
  const go = (next: number, following = false) => {
    const target = Math.max(0, Math.min(steps.length - 1, next))
    lastAdvance.current = Date.now()
    if (replay) {
      useGraphStore.getState().replaySeekFrame(target)
      if (following) useGraphStore.getState().setReplayPlaying(true)
    } else setCursor({id:steps[target].id, index:target, following})
    setIndexOpen(false)
  }
  useLayoutEffect(() => {
    if (previous.current.step.id === step.id) return
    setLeaving(previous.current)
    setDirection(index < previous.current.index ? 'backward' : 'forward')
    previous.current = {step, file:stepFile, index}
    if (body.current) body.current.scrollTop = 0
    const timer = setTimeout(() => setLeaving(null), 240)
    return () => clearTimeout(timer)
  }, [step.id])
  useEffect(() => {
    // Backward replay seeking can remove the selected step. Follow the new
    // playback position instead of keeping a cursor into a different event.
    if (!replay && selected < 0) {
      setCursor(value => ({...value, id:step.id, index}))
      lastAdvance.current = Date.now()
    }
  }, [selected, step.id, index])
  useEffect(() => {
    if (replay || reading || pending <= 0) return
    const dwell = Math.min(7500, Math.max(3500, step.text.split(/\s+/).length * 180))
    const timer = setTimeout(() => go(index + 1, true), Math.max(0, dwell - (Date.now() - lastAdvance.current)))
    return () => clearTimeout(timer)
  }, [reading, pending, index, step.id, step.text, steps.length])
  const navigate = (id: string) => { const target = steps.findIndex(step => step.id === id); if (target >= 0) go(target) }
  const mode = file.status === 'replay' ? 'Replay' : file.status === 'live' ? 'Live' : 'Closed'
  const since = elapsed((file.closedAt ?? now) - file.startedAt)
  return <section className="ambio-case__carousel" aria-label="Investigation steps" aria-roledescription="carousel"
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation()
        go(event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1))
      }
    }}>
    <header className="ambio-case__header">
      <strong className="ambio-case__title" title={file.name}>{file.name}</strong>
      <button type="button" className="ambio-case__close" aria-label={file.status === 'closed' ? 'Dismiss the closed case' : 'Minimize the case'} title={file.status === 'closed' ? 'Dismiss' : 'Minimize'} onClick={onDismiss}>{file.status === 'closed' ? '×' : '–'}</button>
      <div className="ambio-case__metadata">
        <span className="ambio-case__mode" data-status={file.status}>{file.status === 'live' && <span className="ambio-case__live-dot" aria-hidden="true" />}{mode}</span>
        <span className="ambio-case__elapsed" title={`${file.hypotheses.length} hypotheses, ${file.runs.length} experiments`}>{replay ? `${replay.events.length} events` : since}</span>
        <button type="button" className="ambio-case__step-index" aria-label={`Investigation step ${index + 1} of ${steps.length}, show all steps`} aria-expanded={indexOpen} onClick={() => setIndexOpen(value => !value)}>{indexOpen ? 'All steps' : `${String(index + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`}<Chevron expanded={indexOpen} /></button>
        {pending > 0 && <button type="button" className="ambio-case__latest" aria-label="Latest step →" title={`${pending} newer ${pending === 1 ? 'step' : 'steps'}, Jump to latest and follow`} onClick={() => go(steps.length - 1, true)}>+{pending}</button>}
      </div>
    </header>
    <div className="ambio-case__announcement" role="status" aria-atomic="true">Step {index + 1} of {steps.length}: {step.title}</div>
    <div className="ambio-case__viewport" data-direction={direction}>
      {indexOpen ? <div key="step-index" className="ambio-case__body"><ol className="ambio-case__step-list" aria-label="All investigation steps">
        {steps.map((item, n) => <li key={item.id}><button type="button" aria-current={n === index ? 'step' : undefined} onClick={() => go(n)}><span>{String(n + 1).padStart(2,'0')}</span><span><strong>{item.title}</strong><small>{item.label}</small></span><Chevron /></button></li>)}
      </ol></div> : <>
        {leaving && <div key="outgoing-step" className="ambio-case__leaving" aria-hidden="true" ref={element => {if (element) element.inert = true}} data-kind={leaving.step.kind}><StepContent step={leaving.step} file={leaving.file} steps={steps} now={now} navigate={navigate} /></div>}
        <div key={step.id} ref={body} className="ambio-case__body ambio-case__step" data-kind={step.kind} role="group" aria-roledescription="slide" aria-label={`Step ${index + 1} of ${steps.length}: ${step.title}`} tabIndex={0}>
          <StepContent step={step} file={stepFile} steps={steps} now={now} navigate={navigate} />
        </div>
      </>}
    </div>
    <footer className="ambio-case__controls" aria-label="Investigation controls">
      <div className="ambio-case__pager" role="group" aria-label="Browse investigation steps">
        <button type="button" className="ambio-case__arrow" aria-label="Previous investigation step" disabled={index <= 0} onClick={() => go(index - 1)}><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m12 5-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <div className="ambio-case__dots" role="group" aria-label="Investigation pagination">{steps.map((item,n) => n >= dotStart && n < dotStart + 7 && <button key={item.id} type="button" aria-label={`Go to step ${n + 1}: ${item.title}`} title={`Step ${n + 1}: ${item.title}`} aria-current={n === index ? 'step' : undefined} onClick={() => go(n)} />)}</div>
        <button type="button" className="ambio-case__arrow" aria-label="Next investigation step" disabled={pending <= 0} onClick={() => go(index + 1)}><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m8 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      </div>
      {!replay && <button type="button" className="ambio-case__follow" aria-label={following ? 'Pause following' : 'Resume following'} aria-pressed={following} title={following ? 'Following new steps automatically. Click to pause.' : 'Continue with the next queued step and follow new arrivals.'} onClick={() => following ? pause() : go(pending > 0 ? index + 1 : index, true)}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">{following ? <path d="M5 3v10M11 3v10" fill="none" stroke="currentColor" strokeWidth="2" /> : <path d="m4 2 9 6-9 6z" fill="currentColor" />}</svg>
        {following ? 'Following' : 'Resume'}
      </button>}
      {action}
      {error && <p className="ambio-case__error" role="alert">{error}</p>}
    </footer>
  </section>
}

export function CasePanel() {
  const { caseFile, dismissedId, dismissCase, showCase, startReplay, workspaceId, replay } = useGraphStore(useShallow(state => ({
    caseFile: state.caseFile,
    dismissedId: state.caseDismissedId,
    dismissCase: state.dismissCase,
    showCase: state.showCase,
    startReplay: state.startReplay,
    workspaceId: state.currentProject?.id ?? '',
    replay: state.replay,
  })))
  const loadCase = useGraphStore(state => state.loadCase)
  const [now, setNow] = useState(Date.now())

  // A window opened mid-investigation shows the case so far, not an empty map.
  useEffect(() => {
    if (workspaceId) void loadCase(workspaceId)
  }, [workspaceId, loadCase])
  const [replayError, setReplayError] = useState<string | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [availableWidth, setAvailableWidth] = useState(1000)
  const [bottomInset, setBottomInset] = useState({relative:68, fixed:68})
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  useLayoutEffect(() => {
    const parent = anchorRef.current?.parentElement
    if (!parent) return
    const obstacles = [...parent.querySelectorAll<HTMLElement>('.ambio-canvas-bins-panel, .ambio-replay')]
    const measure = () => {
      setAvailableWidth(parent.clientWidth)
      const bounds = parent.getBoundingClientRect()
      const top = Math.min(bounds.bottom - 2, ...obstacles.map(element => element.getBoundingClientRect()).filter(rect => rect.height > 0).map(rect => rect.top))
      const relative = Math.max(14, Math.ceil(bounds.bottom - top + 12))
      const fixed = Math.ceil(window.innerHeight - bounds.bottom + relative)
      setBottomInset(previous => previous.relative === relative && previous.fixed === fixed ? previous : {relative, fixed})
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    obstacles.forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [caseFile?.id, replay?.id])
  const narrow = availableWidth < 340
  useEffect(() => {
    setNarrowExpanded(false); setReplayError(null)
  }, [caseFile?.id])
  const live = caseFile?.status === 'live'

  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const summary = caseFile ? caseSummary(caseFile) : ''

  if (!caseFile) return null
  const placement = {'--case-bottom':`${bottomInset.relative}px`, '--case-fixed-bottom':`${bottomInset.fixed}px`} as React.CSSProperties

  if (dismissedId === caseFile.id || (narrow && !narrowExpanded)) {
    return (
      <><span ref={anchorRef} hidden /><button type="button" className="ambio-case-chip" style={placement} data-status={caseFile.status} title={caseFile.name} onClick={() => { setNarrowExpanded(true); showCase() }}>
        <span className="ambio-case-chip__dot" aria-hidden="true" />
        <span className="ambio-case-chip__name">{caseFile.name}</span>
        <span className="ambio-case-chip__summary">{summary}</span>
      </button></>
    )
  }

  const watchReplay = async () => {
    if (!caseFile.savedId || !workspaceId) return
    setReplayError(null)
    try {
      const document = await apiGetInvestigation(workspaceId, caseFile.savedId) as InvestigationDoc
      const current = useGraphStore.getState()
      if (current.currentProject?.id !== workspaceId || current.caseFile?.id !== caseFile.id) return
      startReplay(document)
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <><span ref={anchorRef} hidden /><aside className="ambio-case nodrag nowheel" style={placement} data-narrow={narrow || undefined} data-status={caseFile.status} data-with-replay={replay ? true : undefined} aria-label={`Investigation: ${caseFile.name}`}>
      <CaseCarousel key={`${caseFile.id}:${caseFile.status === 'replay'}`} file={caseFile} now={now} replay={replay} onDismiss={dismissCase} error={replayError} action={
        live ? <button type="button" className="ambio-case__action" title="Send guidance through the existing chat. Replies arrive with the agent’s next step." onClick={() => { window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', {detail:{investigationId:caseFile.id}})); if (narrow) {setNarrowExpanded(false); dismissCase()} }}>Reply in chat <span aria-hidden="true">↗</span></button>
          : caseFile.status === 'closed' && caseFile.savedId ? <button type="button" className="ambio-case__action" aria-label="Watch the replay" onClick={() => void watchReplay()}>Replay <span aria-hidden="true">↻</span></button>
          : null
      } />
    </aside></>
  )
}
