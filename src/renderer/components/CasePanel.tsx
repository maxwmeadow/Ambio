import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type InvestigationDoc } from '../store/graphStore'
import { apiGetInvestigation } from '../canvas/arcdApi'
import { useShowOnMap } from '../canvas/useShowOnMap'
import {
  caseSummary,
  type CaseAnchor,
  type CaseEntry,
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

const STATUS_LABEL: Record<CaseHypothesis['status'], string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  refuted: 'Ruled out',
  inconclusive: 'Inconclusive',
}

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

function FindingText({ text, conclusion }: { text: string; conclusion: boolean }) {
  const paragraph = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = paragraph.current
    if (!element || expanded) return
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])
  return <>
    <p ref={paragraph} className={expanded ? '' : 'ambio-case__preview'}><Rich text={text} /></p>
    {(expanded || overflows) && <button type="button" className="ambio-case__text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : conclusion ? 'Read full finding' : 'Read more'}</button>}
  </>
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
  return (
    <span className="ambio-case__anchors">
      {anchors.map((a, i) => (
        <button
          key={`${a.fileId}-${a.symbol}-${i}`}
          type="button"
          className="ambio-case__anchor"
          disabled={!a.fileId}
          title={a.fileId ? `Show ${a.relPath} on the map` : a.relPath}
          onClick={() => focus(a)}
        >
          {a.symbol ? <><span>{a.symbol}</span><small>{basename(a.relPath)}</small></> : <span>{basename(a.relPath)}</span>}
        </button>
      ))}
    </span>
  )
}

function basename(path?: string): string {
  if (!path) return ''
  const i = path.lastIndexOf('/')
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
    <details className="ambio-case__run" data-failed={failed || undefined} id={`case-run-${run.id}`}>
      <summary>
        <span className="ambio-case__run-id">R{run.n}{hypothesis ? ` · ${hypothesis.id}` : ''}</span>
        <span className="ambio-case__run-title">{run.error ? 'Could not run' : run.timedOut ? 'Timed out' : failed ? 'Command failed' : 'Command completed'}</span>
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

function Entry({ entry, file }: { entry: CaseEntry; file: CaseFile }) {
  switch (entry.kind) {
    case 'hypothesis': {
      const h = file.hypotheses.find(x => x.id === entry.hypothesisId)
      if (!h) return null
      return (
        <li className="ambio-case__entry" data-kind="hypothesis">
          <span className="ambio-case__entry-label">Question · {h.id}</span>
          <p>{h.text}</p>
          <AnchorChips anchors={h.anchors} />
        </li>
      )
    }
    case 'verdict':
      return (
        <li className="ambio-case__entry" data-kind="verdict" data-status={entry.status}>
          <span className="ambio-case__entry-label">{STATUS_LABEL[entry.status]}</span>
          <p><strong>{entry.hypothesisId}</strong>{entry.text ? ` - ${entry.text}` : ''}</p>
        </li>
      )
    case 'run': {
      const run = file.runs.find(r => r.id === entry.runId)
      if (!run) return null
      const h = run.hypothesisId ? file.hypotheses.find(x => x.id === run.hypothesisId) : undefined
      return (
        <li className="ambio-case__entry" data-kind="run">
          <RunCard run={run} hypothesis={h} />
        </li>
      )
    }
    case 'note':
      return (
        <li className="ambio-case__entry" data-kind="note">
          <span className="ambio-case__entry-label">Found</span>
          <p><Rich text={entry.text} /></p>
          <AnchorChips anchors={entry.anchors} />
        </li>
      )
    case 'message': {
      const m = file.messages.find(x => x.id === entry.messageId)
      if (!m) return null
      return (
        <li className="ambio-case__entry" data-kind="message">
          <span className="ambio-case__entry-label">You</span>
          <p>{m.text}</p>
          <span className="ambio-case__delivery">
            {m.deliveredAt ? 'Delivered to the agent' : file.status === 'live' ? 'Arrives with the agent’s next step' : 'Not delivered'}
          </span>
        </li>
      )
    }
    case 'conclusion':
      return <li className="ambio-case__entry" data-kind="conclusion"><span className="ambio-case__entry-label">Conclusion recorded</span><button type="button" className="ambio-case__text-button" onClick={event => event.currentTarget.closest('.ambio-case__body')?.scrollTo({top:0})}>Back to finding ↑</button></li>
  }
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  useEffect(() => {
    setEvidenceOpen(false); setNarrowExpanded(false); setReplayError(null)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
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

  const hypothesis = caseFile.running
    ? caseFile.hypotheses.find(h => h.id === caseFile.running?.hypothesisId)
    : caseFile.hypotheses.at(-1)
  const lastNote = caseFile.entries.filter(entry => entry.kind !== 'message' && entry.kind !== 'conclusion').at(-1)
  const finding = caseFile.conclusion?.rootCause
    ?? (caseFile.running ? hypothesis?.text ?? 'Observing the code as the command runs.'
      : lastNote?.kind === 'note' ? lastNote.text
      : hypothesis?.verdict || hypothesis?.text
      || (caseFile.runs.length ? 'Experiment complete. Waiting for the agent’s next finding.'
        : caseFile.status === 'replay' ? 'Press Play to watch the investigation unfold.' : caseFile.status === 'closed' ? 'No conclusion was recorded. Any available evidence is kept below.' : 'Waiting for the first question or experiment.'))
  const label = caseFile.conclusion ? 'Finding' : caseFile.status === 'closed' ? 'Ended without a conclusion' : caseFile.running ? caseFile.status === 'replay' ? 'Recorded experiment' : 'Testing now'
    : lastNote?.kind === 'note' ? 'Latest observation' : lastNote?.kind === 'run' ? 'Reviewing result' : hypothesis ? hypothesis.status === 'open' ? 'Current question' : STATUS_LABEL[hypothesis.status] : 'Getting started'
  const verification = caseFile.conclusion?.verified
    ? caseFile.runs.find(run => run.id === caseFile.conclusion?.verified) : undefined

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
      <div className="ambio-case__body" ref={bodyRef}>
        <section className="ambio-case__summary" aria-label="Current finding">
          <span className="ambio-case__entry-label" role="status">{label}</span>
          <FindingText key={caseFile.id} text={finding} conclusion={!!caseFile.conclusion} />
          <AnchorChips anchors={caseFile.conclusion ? caseFile.conclusion.anchors : !caseFile.running && lastNote?.kind === 'note' ? lastNote.anchors : hypothesis?.anchors} />
          {caseFile.running && <div className="ambio-case__running" role="status">
            <span className="ambio-case__live-dot" aria-hidden="true" />
            <span>{caseFile.status === 'replay' ? 'Recorded command' : `Running experiment · ${elapsed(now - caseFile.running.startedAt)}`} </span>
            <code title={caseFile.running.command}>{caseFile.running.command}</code>
            <AnchorChips anchors={caseFile.running.watches} />
          </div>}
          {caseFile.conclusion && <p className="ambio-case__evidence-state">{caseFile.runs.length ? `${caseFile.runs.length} recorded ${caseFile.runs.length === 1 ? 'experiment' : 'experiments'}` : 'Agent conclusion · no experiment recorded'}{verification ? ` · Fix verified by R${verification.n}` : caseFile.conclusion.fix ? ' · No fix verification recorded' : ''}</p>}
          {caseFile.conclusion?.fix && <details className="ambio-case__fix"><summary>Suggested fix</summary><p><Rich text={caseFile.conclusion.fix} /></p></details>}
        </section>
        <div className="ambio-case__evidence-heading">
          <button type="button" className="ambio-case__evidence-toggle" aria-expanded={evidenceOpen} aria-controls="ambio-case-history" onClick={() => setEvidenceOpen(v => !v)}><span className="ambio-case__chevron" aria-hidden="true">›</span>Evidence & history <span>{caseFile.entries.length}</span></button>
          {evidenceOpen && <button type="button" className="ambio-case__text-button" onClick={() => bodyRef.current?.scrollTo({top:bodyRef.current.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})}>Latest step ↓</button>}
        </div>
        <ol id="ambio-case-history" className="ambio-case__story" aria-label="How the investigation unfolded" hidden={!evidenceOpen}>
          {caseFile.entries.length === 0 && <li className="ambio-case__empty">Experiments and observations will appear here.</li>}
          {caseFile.entries.map((entry, i) => <Entry key={`${entry.kind}-${i}`} entry={entry} file={caseFile} />)}
        </ol>
      </div>
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
