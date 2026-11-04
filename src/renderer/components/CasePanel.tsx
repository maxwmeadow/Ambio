import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type InvestigationDoc } from '../store/graphStore'
import { apiGetInvestigation } from '../canvas/arcdApi'
import { useShowOnMap } from '../canvas/useShowOnMap'
import {
  caseSummary,
  caseSteps,
  type CaseStep,
  type CaseAnchor,
  type CaseFile,
  type CaseFinding,
  type CaseHypothesis,
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

/** Keep the agent's wording, but give sentences breathing room. Never invent
 * a summary or silently replace earlier cards with a later assessment. */
function StepText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const prose = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = prose.current?.querySelector('p')
    if (!element || expanded) return
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])
  const parts = text.trim().split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z`])/).filter(Boolean)
  let preview = 1
  if (parts.length > 1 && parts[0].length + parts[1].length < 330) preview = 2
  const visible = expanded ? parts : parts.slice(0, preview)
  return <div ref={prose} className="ambio-case__prose" data-expanded={expanded}>
    {visible.map((part, index) => <p key={index}><Rich text={part} /></p>)}
    {(expanded || overflow || parts.length > preview) && <button type="button" className="ambio-case__text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Continue reading'}</button>}
  </div>
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
      title={a.relPath ? `Show ${a.relPath}${a.symbol ? ` · ${a.symbol}` : ''} on the map` : 'Show referenced code on the map'} onClick={() => focus(a)}>
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
        <span className="ambio-case__finding-mark" aria-hidden="true">{finding.severity === 'high' ? '!' : '·'}</span>
        <span className="ambio-case__finding-text"><Rich text={finding.text} /></span>
      </button>
    </li>
  )
}

function RunCard({ run, hypothesis }: { run: CaseRun; hypothesis?: CaseHypothesis }) {
  const findings = run.findings
  const failed = run.timedOut || run.exitCode !== 0 || !!run.error
  return (
    <details className="ambio-case__run" data-failed={failed || undefined}>
      <summary>
        <span className="ambio-case__run-id">R{run.n}{hypothesis ? ` · ${hypothesis.id}` : ''}</span>
        <span className="ambio-case__run-title">Inspect evidence{findings.length ? ` · ${findings.length} findings` : ''}</span>
        <span className="ambio-case__run-meta">{duration(run.durationMs)} · {run.error ? 'not started' : run.timedOut ? 'timed out' : `exit ${run.exitCode}`}</span>
        <span className="ambio-case__chevron" aria-hidden="true">›</span>
      </summary>
      <div className="ambio-case__run-detail">
        <code className="ambio-case__command">{run.command}</code>
        {hypothesis && <p className="ambio-case__run-tests">Tests {hypothesis.id}</p>}
        {run.error && <p className="ambio-case__run-error">{run.error}</p>}
        {findings.length > 0 ? (
          <ul className="ambio-case__findings" aria-label={`What run R${run.n} showed`}>
            {findings.map((f, i) => <FindingRow key={i} finding={f} />)}
          </ul>
        ) : !run.error && <p className="ambio-case__run-quiet">{run.watched.length
          ? 'No unusual behavior reported in the watched functions.'
          : 'Command output recorded; no watched-function evidence.'}</p>}
        {run.functionsRun != null && <p className="ambio-case__run-meta">{run.functionsRun} functions ran in {run.filesRun ?? 0} files</p>}
        {run.watched.length > 0 && <ul className="ambio-case__watched">
          {run.watched.map((w, i) => <li key={i}>
            <AnchorChips anchors={[w.anchor]} />
            <span>{w.calls} calls{w.errors ? ` · ${w.errors} threw` : ''}</span>
            {w.returns && <p>Returns: <code>{w.returns}</code></p>}
            {w.samples?.length ? <details><summary>Sample calls ({w.samples.length})</summary>
              {w.samples.map((sample, n) => <pre key={n}>{`Call ${sample.call}\nArguments: ${sample.args}${sample.returned ? `\nReturned: ${sample.returned}` : ''}${sample.threw ? `\nThrew: ${sample.threw}` : ''}${sample.mutated?.length ? `\nChanged: ${sample.mutated.join(', ')}` : ''}`}</pre>)}
            </details> : null}
          </li>)}
        </ul>}
        {run.outputTail && <details className="ambio-case__output"><summary>Program output</summary><pre>{run.outputTail}</pre></details>}
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

function StepContent({ step, file, now, navigate }: { step: CaseStep; file: CaseFile; now: number; navigate: (id: string) => void }) {
  const hypothesis = file.hypotheses.find(h => h.id === step.hypothesisId)
  const question = step.hypothesisId ? caseSteps(file).find(s => s.kind === 'hypothesis' && s.hypothesisId === step.hypothesisId) : undefined
  const verified = file.conclusion?.verified ? file.runs.find(run => run.id === file.conclusion?.verified) : undefined
  const linkedRun = verified ?? file.runs.at(-1)
  const evidence = linkedRun ? caseSteps(file).find(s => s.run?.id === linkedRun.id) : undefined
  const message = file.messages.find(m => m.id === step.messageId)
  return <>
    <div className="ambio-case__step-heading">
      <span className="ambio-case__step-icon"><StepIcon kind={step.kind} /></span>
      <div><span className="ambio-case__entry-label">{step.label}</span><h2>{step.title}</h2></div>
    </div>
    <div className="ambio-case__step-content">
      {step.kind === 'running' ? <>
        <p className="ambio-case__experiment-state"><span className="ambio-case__live-dot" aria-hidden="true" />{file.status === 'replay' ? 'Recorded command' : `Running experiment · ${elapsed(now - (file.running?.startedAt ?? now))}`}</p>
        <code className="ambio-case__command">{step.text}</code>
      </> : step.text && <StepText text={step.text} />}
      {question && step.kind !== 'hypothesis' && <button type="button" className="ambio-case__related" onClick={() => navigate(question.id)}>Tests {step.hypothesisId}<span aria-hidden="true">↗</span></button>}
      {step.run && <>
        <p className="ambio-case__result" data-failed={!!step.run.error || step.run.timedOut || step.run.exitCode !== 0}>
          <strong>{step.run.error ? 'Not started' : step.run.timedOut ? 'Timed out' : `Exit ${step.run.exitCode}`}</strong><span>{duration(step.run.durationMs)}</span>
          <span>{step.run.watched.length ? `${step.run.watched.length} watched ${step.run.watched.length === 1 ? 'function' : 'functions'}` : 'No watched-function evidence'}</span>
        </p>
        <RunCard run={step.run} hypothesis={hypothesis} />
      </>}
      <AnchorChips anchors={step.anchors} />
      {step.kind === 'message' && <p className="ambio-case__delivery">{message?.deliveredAt ? 'Delivered to the investigating agent' : file.status === 'live' ? 'Queued for the next investigation step' : 'Not delivered'}</p>}
      {step.kind === 'conclusion' && <div className="ambio-case__outcome">
        <strong>Agent’s conclusion</strong>
        <span>{file.runs.length ? `${file.runs.length} recorded ${file.runs.length === 1 ? 'experiment' : 'experiments'}` : 'No experiment recorded'}</span>
        {evidence && <button type="button" className="ambio-case__text-button" onClick={() => navigate(evidence.id)}>Review experiment R{linkedRun!.n} →</button>}
      </div>}
      {step.kind === 'fix' && <div className="ambio-case__outcome" data-verified={!!verified}>
        <strong>{verified ? `Fix verified by R${verified.n}` : 'No fix verification recorded'}</strong>
        <span>{verified ? 'A verification experiment is linked to this recommendation.' : 'This is a recommendation. Applying it and checking the result are separate steps.'}</span>
        {verified && evidence && <button type="button" className="ambio-case__text-button" onClick={() => navigate(evidence.id)}>Review verification →</button>}
      </div>}
    </div>
  </>
}

/** Incoming steps queue behind a minimum reading interval. Browsing, focus,
 * selection and hover protect the current card; no unattended timed cycling. */
function CaseCarousel({ file, now, playbackCursor }: { file: CaseFile; now: number; playbackCursor?: number }) {
  const steps = useMemo(() => caseSteps(file), [file])
  const [cursor, setCursor] = useState(() => ({id:steps.at(-1)!.id, index:steps.length - 1, following:true, direction:'forward'}))
  const [indexOpen, setIndexOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [leaving, setLeaving] = useState<CaseStep | null>(null)
  const selected = steps.findIndex(step => step.id === cursor.id)
  const index = selected < 0 ? Math.min(cursor.index, steps.length - 1) : selected
  const step = steps[index]
  const previous = useRef(step)
  const previousPlayback = useRef(playbackCursor)
  const lastAdvance = useRef(Date.now())
  const body = useRef<HTMLDivElement>(null)
  const pending = steps.length - index - 1
  const reading = !cursor.following || hovered || indexOpen
  const pause = () => setCursor(value => value.following ? {...value, following:false} : value)
  const go = (next: number, following = false) => {
    const target = Math.max(0, Math.min(steps.length - 1, next))
    lastAdvance.current = Date.now()
    if (following) setHovered(false)
    setCursor({id:steps[target].id, index:target, following, direction:target < index ? 'backward' : 'forward'})
    setIndexOpen(false)
  }
  useLayoutEffect(() => {
    if (previous.current.id === step.id) return
    setLeaving(previous.current)
    previous.current = step
    if (body.current) body.current.scrollTop = 0
    const timer = setTimeout(() => setLeaving(null), 240)
    return () => clearTimeout(timer)
  }, [step.id])
  useEffect(() => {
    // Backward replay seeking can remove the selected step. Follow the new
    // playback position instead of keeping a cursor into a different event.
    if (selected < 0) {
      setCursor(value => ({...value, id:step.id, index, direction:'forward'}))
      lastAdvance.current = Date.now()
    }
  }, [selected, step.id, index])
  useEffect(() => {
    if (reading || pending <= 0) return
    const dwell = Math.min(7500, Math.max(3500, step.text.split(/\s+/).length * 180))
    const timer = setTimeout(() => go(index + 1, true), Math.max(0, dwell - (Date.now() - lastAdvance.current)))
    return () => clearTimeout(timer)
  }, [reading, pending, index, step.id, step.text, steps.length])
  useEffect(() => {
    if (playbackCursor === undefined || previousPlayback.current === playbackCursor) return
    const jumped = previousPlayback.current !== undefined && (playbackCursor < previousPlayback.current || playbackCursor > previousPlayback.current + 1)
    previousPlayback.current = playbackCursor
    if (!jumped && (!cursor.following || hovered)) return
    // The replay transport already supplies its reading intervals. A conclusion
    // first lands on the finding; its separate fix is the following card.
    const target = steps.at(-1)?.kind === 'fix' ? steps.length - 2 : steps.length - 1
    go(target, true)
  }, [playbackCursor])
  const navigate = (id: string) => { const target = steps.findIndex(step => step.id === id); if (target >= 0) go(target) }
  return <section className="ambio-case__carousel" aria-label="Investigation steps" aria-roledescription="carousel"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => {setHovered(false); lastAdvance.current = Date.now()}}
    onFocusCapture={pause} onPointerDown={pause}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation()
        go(event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1))
      }
    }}>
    <div className="ambio-case__progress">
      <button type="button" className="ambio-case__step-index" aria-expanded={indexOpen} onClick={() => {pause();setIndexOpen(value => !value)}}>{indexOpen ? 'Back to step' : `Step ${String(index + 1).padStart(2, '0')}`}<span>{indexOpen ? '×' : ` / ${String(steps.length).padStart(2, '0')} ▾`}</span></button>
      <span className="ambio-case__follow-state" data-following={!reading}>{!reading ? <><span className="ambio-case__live-dot" aria-hidden="true" />{file.status === 'live' ? 'Following live' : file.status === 'replay' ? 'Following playback' : pending ? 'Following steps' : 'Up to date'}</> : pending ? `${pending} newer ${pending === 1 ? 'step' : 'steps'}` : 'Reading this step'}</span>
    </div>
    <div className="ambio-case__announcement" role="status" aria-atomic="true">Step {index + 1} of {steps.length}: {step.title}</div>
    <div className="ambio-case__viewport" data-direction={cursor.direction}>
      {indexOpen ? <div key="step-index" className="ambio-case__body"><ol className="ambio-case__step-list" aria-label="All investigation steps">
        {steps.map((item, n) => <li key={item.id}><button type="button" aria-current={n === index ? 'step' : undefined} onClick={() => go(n)}><span>{String(n + 1).padStart(2,'0')}</span><span><strong>{item.title}</strong><small>{item.label}</small></span><span aria-hidden="true">›</span></button></li>)}
      </ol></div> : <>
        {leaving && <div key="outgoing-step" className="ambio-case__leaving" aria-hidden="true" ref={element => {if (element) element.inert = true}} data-kind={leaving.kind}><StepContent step={leaving} file={file} now={now} navigate={navigate} /></div>}
        <div key={step.id} ref={body} className="ambio-case__body ambio-case__step" data-kind={step.kind} role="group" aria-roledescription="slide" aria-label={`Step ${index + 1} of ${steps.length}: ${step.title}`} tabIndex={0}>
          <StepContent step={step} file={file} now={now} navigate={navigate} />
        </div>
      </>}
    </div>
    <div className="ambio-case__navigation">
      <div className="ambio-case__pager">
        <button type="button" className="ambio-case__arrow" aria-label="Previous investigation step" disabled={index === 0} onClick={() => go(index - 1)}>←</button>
        <div className="ambio-case__dots" aria-label="Nearby steps">{steps.map((item, n) => Math.abs(n - index) <= 3 && <button key={item.id} type="button" aria-label={`Go to step ${n + 1}: ${item.title}`} aria-current={n === index ? 'step' : undefined} onClick={() => go(n)} />)}</div>
        <button type="button" className="ambio-case__arrow" aria-label="Next investigation step" disabled={pending === 0} onClick={() => go(index + 1)}>→</button>
      </div>
      {cursor.following ? <button type="button" className="ambio-case__follow" onClick={pause}>Ⅱ Pause following</button> : <button type="button" className="ambio-case__follow" onClick={() => go(index, true)}>▶ Resume following</button>}
      {pending > 0 && <button type="button" className="ambio-case__latest" onClick={() => go(steps.length - 1, true)}>Latest step →</button>}
    </div>
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
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  useLayoutEffect(() => {
    const parent = anchorRef.current?.parentElement
    if (!parent) return
    const measure = () => setAvailableWidth(parent.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [caseFile?.id])
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

  if (dismissedId === caseFile.id || (narrow && !narrowExpanded)) {
    return (
      <><span ref={anchorRef} hidden /><button type="button" className="ambio-case-chip" data-status={caseFile.status} title={caseFile.name} onClick={() => { setNarrowExpanded(true); showCase() }}>
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

  const mode = caseFile.status === 'replay' ? 'Replay' : live ? 'Live' : 'Closed'
  const endedAt = caseFile.closedAt ?? now
  const since = elapsed((live ? now : endedAt) - caseFile.startedAt)
  const counts = [
    caseFile.hypotheses.length && `${caseFile.hypotheses.length} hypothes${caseFile.hypotheses.length === 1 ? 'is' : 'es'}`,
    caseFile.runs.length && `${caseFile.runs.length} run${caseFile.runs.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ')

  return (
    <><span ref={anchorRef} hidden /><aside className="ambio-case nodrag nowheel" data-narrow={narrow || undefined} data-status={caseFile.status} data-with-replay={replay ? true : undefined} aria-label={`Investigation: ${caseFile.name}`}>
      <header className="ambio-case__header">
        <div className="ambio-case__identity">
          <span className="ambio-case__eyebrow">Investigation <span className="ambio-case__mode" data-status={caseFile.status}>{live && <span className="ambio-case__live-dot" aria-hidden="true" />}{mode}</span></span>
          <strong title={caseFile.name}>{caseFile.name}</strong>
          <span>{caseFile.status === 'replay' ? 'Saved investigation' : since}{counts ? ` · ${counts}` : ''}</span>
        </div>
        <button type="button" className="ambio-case__close" aria-label={caseFile.status === 'closed' ? 'Dismiss the closed case' : 'Minimize the case'} title={caseFile.status === 'closed' ? 'Dismiss' : 'Minimize'} onClick={dismissCase}>{caseFile.status === 'closed' ? '×' : '–'}</button>
      </header>
      <CaseCarousel key={`${caseFile.id}:${caseFile.status === 'replay'}`} file={caseFile} now={now} playbackCursor={replay?.cursor} />
      <footer className="ambio-case__footer">
        {live ? <button type="button" className="ambio-case__action" onClick={() => { window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', {detail:{investigationId:caseFile.id}})); if (narrow) {setNarrowExpanded(false); dismissCase()} }}>Reply in chat <span aria-hidden="true">↗</span></button>
          : caseFile.status === 'closed' && caseFile.savedId ? <button type="button" className="ambio-case__action" onClick={() => void watchReplay()}>Watch the replay <span aria-hidden="true">↻</span></button>
          : <span>{caseFile.status === 'replay' ? 'Playback · messages are read-only' : 'Investigation closed'}</span>}
        {live && <span>Replies arrive with the next step</span>}
        {replayError && <p className="ambio-case__error" role="alert">{replayError}</p>}
      </footer>
    </aside></>
  )
}
