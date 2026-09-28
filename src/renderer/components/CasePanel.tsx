import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type InvestigationDoc } from '../store/graphStore'
import { apiGetInvestigation } from '../canvas/arcdApi'
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
  open: 'Testing',
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

function useFocus() {
  const setSelectedNode = useGraphStore(state => state.setSelectedNode)
  return (anchor?: CaseAnchor) => {
    if (anchor?.fileId) setSelectedNode(anchor.fileId)
  }
}

function AnchorChips({ anchors }: { anchors?: CaseAnchor[] }) {
  const focus = useFocus()
  if (!anchors?.length) return null
  return (
    <span className="axiom-case__anchors">
      {anchors.map((a, i) => (
        <button
          key={`${a.fileId}-${a.symbol}-${i}`}
          type="button"
          className="axiom-case__anchor"
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
    <li className="axiom-case__finding" data-severity={finding.severity}>
      <button type="button" disabled={!clickable} onClick={() => focus(finding.anchor)} title={clickable ? 'Show on the map' : undefined}>
        <span className="axiom-case__finding-mark" aria-hidden="true">{finding.severity === 'high' ? '!' : '·'}</span>
        <span className="axiom-case__finding-text"><Rich text={finding.text} /></span>
      </button>
    </li>
  )
}

function RunCard({ run, hypothesis }: { run: CaseRun; hypothesis?: CaseHypothesis }) {
  const [showOutput, setShowOutput] = useState(false)
  const findings = run.findings.filter(f => f.severity !== 'info')
  const failed = run.timedOut || run.exitCode !== 0 || !!run.error
  return (
    <article className="axiom-case__run" data-failed={failed || undefined}>
      <header>
        <span className="axiom-case__run-id">R{run.n}</span>
        <code className="axiom-case__run-command" title={run.command}>{run.command}</code>
        <span className="axiom-case__run-meta">
          {run.error ? 'could not run' : run.timedOut ? 'timed out' : `exit ${run.exitCode}`} · {duration(run.durationMs)}
        </span>
      </header>
      {hypothesis && <p className="axiom-case__run-tests">Testing {hypothesis.id}: {hypothesis.text}</p>}
      {run.error && <p className="axiom-case__run-error">{run.error}</p>}
      {findings.length > 0 ? (
        <ul className="axiom-case__findings" aria-label={`What run R${run.n} showed`}>
          {findings.slice(0, 5).map((f, i) => <FindingRow key={i} finding={f} />)}
        </ul>
      ) : !run.error && (
        <p className="axiom-case__run-quiet">
          Nothing unusual in the watched code{run.functionsRun ? ` · ${run.functionsRun} functions ran in ${run.filesRun} files` : ''}
        </p>
      )}
      {run.watched.length > 0 && (
        <ul className="axiom-case__watched">
          {run.watched.map((w, i) => (
            <li key={i}>
              <code>{w.anchor.symbol}</code> ×{w.calls}{w.errors ? ` · ${w.errors} threw` : ''}{w.returns ? ` · returns ${w.returns}` : ''}
            </li>
          ))}
        </ul>
      )}
      {run.outputTail && (
        <div className="axiom-case__output">
          <button type="button" aria-expanded={showOutput} onClick={() => setShowOutput(v => !v)}>
            {showOutput ? 'Hide output' : 'Program output'}
          </button>
          {showOutput && <pre>{run.outputTail}</pre>}
        </div>
      )}
    </article>
  )
}

function Entry({ entry, file }: { entry: CaseEntry; file: CaseFile }) {
  switch (entry.kind) {
    case 'hypothesis': {
      const h = file.hypotheses.find(x => x.id === entry.hypothesisId)
      if (!h) return null
      return (
        <li className="axiom-case__entry" data-kind="hypothesis">
          <span className="axiom-case__entry-label">Suspects</span>
          <p><strong>{h.id}</strong> {h.text}</p>
          <AnchorChips anchors={h.anchors} />
        </li>
      )
    }
    case 'verdict':
      return (
        <li className="axiom-case__entry" data-kind="verdict" data-status={entry.status}>
          <span className="axiom-case__entry-label">{STATUS_LABEL[entry.status]}</span>
          <p><strong>{entry.hypothesisId}</strong>{entry.text ? ` - ${entry.text}` : ''}</p>
        </li>
      )
    case 'run': {
      const run = file.runs.find(r => r.id === entry.runId)
      if (!run) return null
      const h = run.hypothesisId ? file.hypotheses.find(x => x.id === run.hypothesisId) : undefined
      return (
        <li className="axiom-case__entry" data-kind="run">
          <RunCard run={run} hypothesis={h} />
        </li>
      )
    }
    case 'note':
      return (
        <li className="axiom-case__entry" data-kind="note">
          <span className="axiom-case__entry-label">Found</span>
          <p><Rich text={entry.text} /></p>
          <AnchorChips anchors={entry.anchors} />
        </li>
      )
    case 'message': {
      const m = file.messages.find(x => x.id === entry.messageId)
      if (!m) return null
      return (
        <li className="axiom-case__entry" data-kind="message">
          <span className="axiom-case__entry-label">You</span>
          <p>{m.text}</p>
          <span className="axiom-case__delivery">
            {m.deliveredAt ? 'Delivered to the agent' : file.status === 'live' ? 'Arrives with the agent’s next step' : 'Not delivered'}
          </span>
        </li>
      )
    }
    case 'conclusion':
      return null // shown pinned above the story
  }
}

function Composer({ disabled }: { disabled: boolean }) {
  const sendCaseMessage = useGraphStore(state => state.sendCaseMessage)
  const selected = useGraphStore(state => state.selectedNodeId)
  const files = useGraphStore(state => state.files)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attach, setAttach] = useState(true)
  const selectedFile = selected ? files.find(f => f.id === selected) : undefined

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    try {
      await sendCaseMessage(body, attach && selectedFile ? { fileId: selectedFile.id, relPath: selectedFile.relPath } : undefined)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="axiom-case__composer"
      onSubmit={event => { event.preventDefault(); void send() }}
    >
      <label htmlFor="axiom-case-message" className="axiom-case__composer-label">Tell the agent</label>
      <textarea
        id="axiom-case-message"
        value={text}
        disabled={disabled || sending}
        rows={2}
        placeholder={disabled ? 'The case is closed' : 'A hint, a correction, a question…'}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void send()
          }
        }}
      />
      <div className="axiom-case__composer-row">
        {selectedFile && !disabled ? (
          <label className="axiom-case__attach">
            <input type="checkbox" checked={attach} onChange={event => setAttach(event.target.checked)} />
            Pointing at {basename(selectedFile.relPath)}
          </label>
        ) : <span className="axiom-case__hint">Select a file on the map to point at it</span>}
        <button type="submit" disabled={disabled || sending || !text.trim()}>{sending ? 'Sending…' : 'Send'}</button>
      </div>
      {error && <p className="axiom-case__error" role="alert">{error}</p>}
    </form>
  )
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
  const storyRef = useRef<HTMLOListElement>(null)
  const stickToBottom = useRef(true)
  const live = caseFile?.status === 'live'

  useEffect(() => {
    if (!live && !caseFile?.running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, caseFile?.running])

  const entryCount = caseFile?.entries.length ?? 0
  useLayoutEffect(() => {
    const el = storyRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [entryCount, caseFile?.running])

  const summary = useMemo(() => (caseFile ? caseSummary(caseFile) : ''), [caseFile])

  if (!caseFile) return null

  if (dismissedId === caseFile.id) {
    return (
      <button type="button" className="axiom-case-chip" data-status={caseFile.status} onClick={showCase}>
        <span className="axiom-case-chip__dot" aria-hidden="true" />
        <span className="axiom-case-chip__name">{caseFile.name}</span>
        <span className="axiom-case-chip__summary">{summary}</span>
      </button>
    )
  }

  const watchReplay = async () => {
    if (!caseFile.savedId || !workspaceId) return
    setReplayError(null)
    try {
      startReplay(await apiGetInvestigation(workspaceId, caseFile.savedId) as InvestigationDoc)
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
    <aside className="axiom-case" data-status={caseFile.status} data-with-replay={replay ? true : undefined} aria-label={`Investigation: ${caseFile.name}`}>
      <header className="axiom-case__header">
        <span className="axiom-case__mode" data-status={caseFile.status}>
          {live && <span className="axiom-case__live-dot" aria-hidden="true" />}
          {mode}
        </span>
        <div className="axiom-case__identity">
          <strong title={caseFile.name}>{caseFile.name}</strong>
          <span>{caseFile.status === 'replay' ? 'Saved investigation' : since}{counts ? ` · ${counts}` : ''}</span>
        </div>
        <button
          type="button"
          className="axiom-case__close"
          aria-label={caseFile.status === 'closed' ? 'Dismiss the closed case' : 'Minimize the case'}
          title={caseFile.status === 'closed' ? 'Dismiss' : 'Minimize'}
          onClick={dismissCase}
        >
          {caseFile.status === 'closed' ? '×' : '–'}
        </button>
      </header>

      <div className="axiom-case__summary" aria-live="polite">
        <span>{caseFile.conclusion ? 'Root cause' : 'So far'}</span>
        <p><Rich text={summary} /></p>
        {caseFile.conclusion && <AnchorChips anchors={caseFile.conclusion.anchors} />}
        {caseFile.conclusion?.fix && <p className="axiom-case__fix"><span>Fix</span> {caseFile.conclusion.fix}</p>}
        {caseFile.conclusion && (
          <p className="axiom-case__verified" data-verified={caseFile.conclusion.verified ? true : undefined}>
            {caseFile.conclusion.verified
              ? `Verified by R${caseFile.runs.find(r => r.id === caseFile.conclusion?.verified)?.n ?? '?'}`
              : 'Not yet verified by a run'}
          </p>
        )}
      </div>

      {caseFile.status === 'closed' && (
        <div className="axiom-case__closed">
          <p>The agent closed this case{caseFile.conclusion ? '' : ' without a stated root cause'}.</p>
          {caseFile.savedId && <button type="button" onClick={() => void watchReplay()}>Watch the replay</button>}
          {replayError && <p className="axiom-case__error" role="alert">{replayError}</p>}
        </div>
      )}

      {caseFile.hypotheses.length > 0 && (
        <section className="axiom-case__board" aria-label="Hypotheses">
          {caseFile.hypotheses.map(h => (
            <div key={h.id} className="axiom-case__hypothesis" data-status={h.status}>
              <span className="axiom-case__hypothesis-id">{h.id}</span>
              <span className="axiom-case__hypothesis-text">{h.text}</span>
              <span className="axiom-case__hypothesis-status">{STATUS_LABEL[h.status]}</span>
            </div>
          ))}
        </section>
      )}

      <ol
        className="axiom-case__story"
        ref={storyRef}
        aria-label="How the investigation unfolded"
        onScroll={event => {
          const el = event.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {caseFile.entries.length === 0 && !caseFile.running && (
          <li className="axiom-case__empty">
            {caseFile.status === 'replay'
              ? 'Press Play to watch the investigation unfold.'
              : 'The agent has opened the case. Its hypotheses and experiments will appear here as it works.'}
          </li>
        )}
        {caseFile.entries.map((entry, i) => <Entry key={`${entry.kind}-${i}`} entry={entry} file={caseFile} />)}
        {caseFile.running && (
          <li className="axiom-case__entry" data-kind="running" aria-live="polite">
            <span className="axiom-case__entry-label">Running</span>
            <p><code>{caseFile.running.command}</code> · {elapsed(now - caseFile.running.startedAt)}</p>
            {caseFile.running.watches.length > 0 && (
              <p className="axiom-case__watching">Watching <AnchorChips anchors={caseFile.running.watches} /></p>
            )}
          </li>
        )}
      </ol>

      {caseFile.status !== 'replay' && <Composer disabled={!live} />}
    </aside>
  )
}
