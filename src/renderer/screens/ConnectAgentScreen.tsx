import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { MappingAttempt } from '../../shared/agentDelivery'
import { useProposalStore } from '../store/architectureProposalStore'
import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'
import { AgentMascot } from '../components/AgentMascot'
import { startMapping, stopMappingRun, MappingActivity, rememberedMappingRun, rememberMappingRun, type MappingChoice, type MappingRun, type MappingState, type MappingSummary } from './MapWithAgent'
import { ChooseAgent } from './ChooseAgent'
import { discoveryRequest } from '../components/agentDiscovery'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import {
  connectionCheckPrompt,
  installOutcomeNote,
  presentAgentHost,
  type AgentHostState,
} from './connectAgentPresentation'
import { archdApi } from '../archdEndpoint.ts'
import { rememberSetupStep, rememberedSetupStep } from '../projectLocalState'

const RESCAN_MINIMUM_MS = 900

const POLL_MS = 2000

type SetupStep = 1 | 2 | 3

interface AgentPresenceResponse {
  connected: boolean
  connections: Array<{ connectionId: string; hostId: string; lastSeenAt: number; lastToolAt?: number }>
}

interface Props {
  project: ProjectConfig
  fileCount: number
  indexing: boolean
  blankProject: boolean
  backLabel?: string
  onComplete: () => void
  onReview: () => void
  onSkip: () => void
  onBack: () => void
}

const BLANK_PROJECT_STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: 1, label: 'Choose agent' },
  { id: 2, label: 'Connect' },
]

const CODEBASE_STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: 1, label: 'Choose agent' },
  { id: 2, label: 'Map project' },
  { id: 3, label: 'Review' },
]

export function ConnectAgentScreen({
  project, fileCount, indexing, blankProject, backLabel = '← Projects', onComplete, onReview, onSkip, onBack,
}: Props) {
  // Reopening the project returns to the step it was left on.
  const [activeStep, setActiveStepState] = useState<SetupStep>(() => {
    const saved = rememberedSetupStep(project.id) ?? 1
    return Math.min(saved, blankProject ? 2 : 3) as SetupStep
  })
  const setActiveStep = useCallback((step: SetupStep) => {
    setActiveStepState(step)
    rememberSetupStep(project.id, step)
  }, [project.id])
  const [copied, setCopied] = useState(false)
  const [hosts, setHosts] = useState<AgentHostInfo[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, AgentInstallResult>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  // A family opens by itself while one of its surfaces needs a decision
  // (install or repair); after that the user's own toggle wins.
  // One line under a surface after an install or a removal, and one under a
  // family when installing all of it failed.
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [rescanning, setRescanning] = useState(false)
  const [hostDiscoveryError, setHostDiscoveryError] = useState('')
  const [locateNotices, setLocateNotices] = useState<Record<string, string>>({})
  const [hasLivePresence, setHasLivePresence] = useState(false)
  const [liveHostIds, setLiveHostIds] = useState<Set<string>>(() => new Set())
  const [verifiedHostIds, setVerifiedHostIds] = useState<Set<string>>(() => new Set())
  // A mapping Ambio is running itself needs no install, restart or command.
  const [mappingRun, setMappingRun] = useState<MappingRun | null>(() => blankProject ? null : rememberedMappingRun(project.id))
  const [mappingRecord, setMappingRecord] = useState<MappingAttempt | null>(null)
  const readyForReview = !!mappingRun?.attemptId && mappingRecord?.id === mappingRun.attemptId && mappingRecord.state === 'submitted' && !!mappingRecord.endedAt
  const [mappingState, setMappingState] = useState<MappingState | null>(null)
  const [mappingSummary, setMappingSummary] = useState<MappingSummary | null>(null)
  const handleRetry = useCallback(async () => {
    if (!mappingRun) return
    try {
      await stopMappingRun(mappingRun)
      setMappingWarning('')
      let choice
      if (mappingRun.kind === 'run') {
        const host = (await window.ambio.listDeliveryHosts()).find(item => item.id === mappingRun.hostId)
        if (!host) throw new Error('This agent is unavailable. Choose another agent.')
        choice = { id: host.id, label: mappingRun.label, kind: 'run' as const, host }
      } else {
        const conversation = (await window.ambio.chatConversations(project.id)).find(item => item.id === mappingRun.conversationId)
        const provider = (await window.ambio.chatProviders()).find(item => item.id === conversation?.providerId)
        if (!provider) throw new Error('This model service is unavailable. Choose another agent.')
        choice = { id: `chat:${provider.id}`, label: mappingRun.label, kind: 'chat' as const, provider }
      }
      const { run, warning } = await startMapping({ choice, workspaceId: project.id, projectRoot: project.rootPath, model: mappingRun.model })
      setMappingRecord(null)
      movedToReview.current = false
      setMappingState(null)
      setMappingWarning(warning ?? '')
      setMappingRun(run)
      setActiveStep(2)
    } catch (error) { setMappingWarning(error instanceof Error ? error.message : String(error)) }
  }, [mappingRun, project.id, project.rootPath, setActiveStep])
  const [mappingChoice, setMappingChoice] = useState<MappingChoice>(null)
  const [connectorSidebarTarget, setConnectorSidebarTarget] = useState<HTMLDivElement | null>(null)
  const [mappingWarning, setMappingWarning] = useState('')
  const [confirmSkipOpen, setConfirmSkipOpen] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userSelectedHost = useRef(false)

  useEffect(() => {
    if (!confirmSkipOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmSkipOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmSkipOpen])

  const showHosts = useCallback((found: AgentHostInfo[]) => {
    setHosts(found)
    setSelectedHostId(current => {
      if (current && found.some(host => host.id === current)) return current
      return found.find(host => host.configured && host.workflowInstalled)?.id
        ?? found.find(host => host.detected)?.id
        ?? found[0]?.id
        ?? null
    })
  }, [])

  const hostScan = useRef(0)
  const refreshHosts = useCallback(async () => {
    const request = ++hostScan.current
    try {
      const found = await discoveryRequest(() => window.ambio.listAgentHosts(project.rootPath))
      if (request === hostScan.current) { showHosts(found); setHostDiscoveryError('') }
    } catch {
      if (request === hostScan.current) setHostDiscoveryError('Could not check app installations. Rescan to retry.')
    }
  }, [project.rootPath, showHosts])
  useEffect(() => {
    void refreshHosts()
    return () => { ++hostScan.current; if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [refreshHosts])

  useEffect(() => {
    if (userSelectedHost.current || liveHostIds.size === 0) return
    const liveHost = hosts.find(host => liveHostIds.has(host.connectionHostId ?? host.id))
    if (liveHost) setSelectedHostId(liveHost.id)
  }, [hosts, liveHostIds])

  // A live presence response is the gate.
  useEffect(() => {
    let active = true
    const poll = async () => {
      const workspace = encodeURIComponent(project.id)
      if (mappingRun?.attemptId) {
        try {
          const res = await fetch(`${archdApi()}/api/mapping-attempts/${encodeURIComponent(mappingRun.attemptId)}?workspace=${workspace}`)
          if (res.ok && active) setMappingRecord(await res.json() as MappingAttempt)
        } catch { /* no successful shutdown confirmation means Review remains locked */ }
      }

      try {
        const res = await fetch(`${archdApi()}/api/agent/presence?workspace=${workspace}`)
        if (res.ok) {
          const body = await res.json() as AgentPresenceResponse
          setHasLivePresence(body.connected)
          setLiveHostIds(new Set(
            (body.connections ?? []).map(item => item.hostId).filter(id => id !== 'unknown'),
          ))
          setVerifiedHostIds(new Set(
            (body.connections ?? []).filter(item => (item.lastToolAt ?? 0) > 0).map(item => item.hostId),
          ))
        }
      } catch { /* the next poll retries */ }


    }

    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { active = false; clearInterval(timer) }
  }, [project.id, mappingRun?.attemptId])

  const selectedHost = useMemo(
    () => hosts.find(host => host.id === selectedHostId) ?? hosts[0] ?? null,
    [hosts, selectedHostId],
  )

  useEffect(() => {
    const maxStep = blankProject ? 2 : 3
    if (activeStep > maxStep) setActiveStep(maxStep as SetupStep)
  }, [blankProject, activeStep, setActiveStep])

  // Advance to review when a proposed architecture arrives.
  const movedToReview = useRef(false)
  useEffect(() => {
    if (blankProject || movedToReview.current) return
    if (activeStep !== 2) return
    if (!readyForReview) return
    movedToReview.current = true
    setActiveStep(3)
  }, [blankProject, activeStep, setActiveStep, readyForReview])

  // The mascot follows the chosen agent, in that agent's terms: an agent Ambio
  // runs is ready without connecting; one in another app waits for its chat.
  const otherAppName = selectedHost?.modalityLabel || selectedHost?.label || 'your agent'
  const otherAppInstalled = !!selectedHost && selectedHost.configured && selectedHost.workflowInstalled
  const mappingLabel = mappingRun ? (mappingRun.kind === 'chat' ? 'Ambio chat' : mappingRun.label) : ''
  const mappingActive = !!mappingRun && (mappingState === null || mappingState === 'working' || mappingState === 'waiting' || mappingState === 'finishing')
  const mascot: { state: 'sleeping' | 'connected' | 'proposal-ready'; caption?: string } =
    !blankProject && readyForReview ? { state: 'proposal-ready' }
      : mappingActive ? { state: 'connected', caption: mappingState === 'finishing' ? 'Map submitted - closing the agent session before review.' : mappingState === 'waiting' ? `Waiting - ${mappingLabel} needs your answer.` : `Working - ${mappingLabel} is mapping the project.` }
        : mappingRun ? { state: 'connected', caption: `Ready - the last mapping ${mappingState === 'stopped' ? 'was stopped' : mappingState === 'done' ? 'finished without a proposal' : 'did not finish'}. Choose again to retry.` }
          : hasLivePresence ? { state: 'connected', caption: `Ready - ${liveHostIds.size && selectedHost && liveHostIds.has(selectedHost.connectionHostId ?? selectedHost.id) ? otherAppName : 'your agent'} is connected.` }
            : !blankProject && activeStep === 1 && mappingChoice?.kind === 'setup' ? { state: 'sleeping', caption: 'Asleep - connect ChatGPT or add an API key to use Ambio chat.' }
              : activeStep === 1 && mappingChoice?.available === false ? { state: 'sleeping', caption: `Needs setup - ${mappingChoice.label}. Select its pill for details.` }
              : activeStep === 1 && mappingChoice?.kind === 'run' ? { state: 'connected', caption: `Found - ${mappingChoice.label}. Sign in to this CLI before mapping.` }
              : !blankProject && activeStep === 1 && mappingChoice ? { state: 'connected', caption: `Ready - ${mappingChoice.label} is ready. Press Map to start.` }
                : blankProject && activeStep === 1 ? { state: 'connected', caption: 'Ready - Ambio chat and the agents Ambio runs need no setup.' }
                  : otherAppInstalled ? { state: 'sleeping', caption: `Waiting - restart ${otherAppName} so it can connect.` }
                    : { state: 'sleeping', caption: 'Asleep - no agent is ready yet.' }
  const fieldAgentCommentary = useMemo(() => {
    if (!mappingRun) return ''
    const label = mappingLabel || 'The agent'
    if (readyForReview) {
      return 'Architecture proposal ready! You can review the systems, nesting, and file placement.'
    }
    if (mappingState === 'failed') {
      return `${label} stopped before completing the map. You can retry now or choose another agent.`
    }
    if (mappingState === 'stopped') {
      return `${label}'s mapping run was stopped. You can retry with ${label} or pick another agent.`
    }
    if (mappingState === 'waiting') {
      return `${label} has paused and needs your answer. Check the prompt to proceed.`
    }
    if (mappingSummary && mappingSummary.systemsCount > 0) {
      return `${mappingSummary.systemsCount} ${mappingSummary.systemsCount === 1 ? 'system' : 'systems'} drafted on your canvas! ${label} is defining connections and boundaries.`
    }
    if (mappingSummary && mappingSummary.filesCount > 0) {
      return `${label} is scanning codebase structure (${mappingSummary.filesCount} ${mappingSummary.filesCount === 1 ? 'file' : 'files'} inspected). Tracing imports to discover systems.`
    }
    return `Observing ${label} as it explores your repository. Systems will be proposed and drawn as it analyzes your code.`
  }, [mappingRun, mappingLabel, readyForReview, mappingState, mappingSummary])

  const mascotState = mascot.state

  const selectedPresentation = selectedHost
    ? presentAgentHost(selectedHost, results[selectedHost.id], liveHostIds.has(selectedHost.id))
    : null

  const selectedReady = selectedPresentation?.state === 'installed' || selectedPresentation?.state === 'live'
  const selectedOnline = !!selectedHost && liveHostIds.has(selectedHost.connectionHostId ?? selectedHost.id)
  const selectedVerified = !!selectedHost && verifiedHostIds.has(selectedHost.connectionHostId ?? selectedHost.id)

  const rescan = useCallback(async () => {
    setRescanning(true)
    const startedAt = Date.now()
    try {
      await refreshHosts()
    } catch {
      setHostDiscoveryError('Could not check app installations. Rescan to retry.')
    } finally {
      // Scanning is a handful of existsSync calls and finishes far too fast to
      // see. Without a floor the button appears inert, and the user cannot
      // tell a completed scan from a dead control.
      const remaining = RESCAN_MINIMUM_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      setRescanning(false)
    }
  }, [refreshHosts])

  // Detection is guesswork about paths; this is how a user corrects it.
  const locateHost = useCallback(async (host: AgentHostInfo) => {
    const outcome = await window.ambio.locateAgentHost(host.id)
    if (outcome.ok) {
      setLocateNotices(previous => ({ ...previous, [host.id]: outcome.detail }))
      await refreshHosts()
      return
    }
    // A cancelled dialog is not an error worth reporting back.
    if (outcome.detail !== 'Cancelled.') {
      setLocateNotices(previous => ({ ...previous, [host.id]: outcome.detail }))
    }
  }, [refreshHosts])

  const clearHostOverride = useCallback(async (host: AgentHostInfo) => {
    const outcome = await window.ambio.clearAgentHostOverride(host.id)
    setLocateNotices(previous => ({ ...previous, [host.id]: outcome.detail }))
    await refreshHosts()
  }, [refreshHosts])

  const chooseHost = (hostId: string) => {
    userSelectedHost.current = true
    setSelectedHostId(hostId)
  }

  const installHost = async (candidate: AgentHostInfo) => {
    setSelectedHostId(candidate.id)
    userSelectedHost.current = true
    setInstalling(candidate.id)
    try {
      const outcome = await window.ambio.installAgent(candidate.id, project.rootPath)
      setResults(current => ({ ...current, [candidate.id]: outcome }))
      setNotes(current => ({ ...current, [candidate.id]: installOutcomeNote(candidate, 'install', outcome) }))
      if (outcome.ok) await refreshHosts()
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Ambio could not inspect the updated configuration.'
      setResults(current => ({ ...current, [candidate.id]: { ok: false, detail, paths: [] } }))
      setNotes(current => ({ ...current, [candidate.id]: { ok: false, text: detail } }))
    } finally {
      setInstalling(null)
    }
  }

  const removeHost = async (candidate: AgentHostInfo) => {
    setInstalling(candidate.id)
    try {
      const outcome = await window.ambio.uninstallAgent(candidate.id, project.rootPath)
      // An earlier install result must not keep the row looking installed.
      setResults(current => { const { [candidate.id]: _removed, ...rest } = current; return rest })
      setNotes(current => ({ ...current, [candidate.id]: installOutcomeNote(candidate, 'remove', outcome) }))
      await refreshHosts()
    } finally {
      setInstalling(null)
    }
  }

  const copyText = async (text?: string | null) => {
    if (!text) return
    try {
      // The main process writes reliably; the web clipboard refuses when the
      // window is not focused, and the copy then silently does nothing.
      if (window.ambio?.copyText) await window.ambio.copyText(text)
      else await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2200)
    } catch {
      setCopied(false)
    }
  }

  const stepComplete = (step: SetupStep) => {
    if (blankProject) {
      if (step === 1) {
        return hosts.some(host => {
          const state = presentAgentHost(host, results[host.id], liveHostIds.has(host.connectionHostId ?? host.id)).state
          return state === 'installed' || state === 'live'
        })
      }
      if (step === 2) return selectedVerified
      return false
    }
    if (step === 1) return !!mappingRun
    if (step === 2) return readyForReview
    return false
  }

  const stepLabels = blankProject ? BLANK_PROJECT_STEPS : CODEBASE_STEPS


  return (
    <div className="ambio-connect">
      <WorkbenchTitleBar
        className="ambio-connect__titlebar"
        status={indexing ? 'INDEXING' : 'AGENT SETUP'}
        statusTone={indexing ? 'busy' : 'ready'}
      />

      <main className="ambio-connect__card">
        <header className="ambio-connect__header">
          <button type="button" className="ambio-connect__back" onClick={onBack}>{backLabel}</button>
          <div className="ambio-connect__identity">
            <h1>Bring an agent into Ambio</h1>
            {indexing && <span className="ambio-connect__indexed">Reading source…</span>}
          </div>
        </header>

        <nav
          className="ambio-connect__step-nav"
          data-mode={blankProject ? 'blank' : 'codebase'}
          data-steps={stepLabels.length}
          style={{ gridTemplateColumns: `repeat(${stepLabels.length}, minmax(0, 1fr))` }}
          aria-label="Agent setup steps"
          role="tablist"
        >
          {stepLabels.map(step => (
            <button
              key={step.id}
              type="button"
              role="tab"
              aria-selected={activeStep === step.id}
              aria-controls="agent-setup-stage"
              data-state={stepComplete(step.id) ? 'done' : activeStep === step.id ? 'active' : 'idle'}
              onClick={() => setActiveStep(step.id)}
            >
              <span>{stepComplete(step.id) ? '✓' : step.id}</span>
              {step.label}
            </button>
          ))}
        </nav>

        <div className="ambio-connect__workspace">
          <section id="agent-setup-stage" className="ambio-connect__stage" role="tabpanel">
            {activeStep === 1 && (
              <div className="ambio-connect__step-panel ambio-connect__step-panel--pinned">
                <h2>{blankProject ? 'Choose your agent' : 'Choose who maps this project'}</h2>
                {mappingRun
                  ? <div className="ambio-connect__scroll"><MappingActivity run={mappingRun} onState={setMappingState} onSummary={setMappingSummary} onRetry={handleRetry} onDismiss={() => setMappingRun(null)} /></div>
                  : <ChooseAgent
                    sidebarTarget={connectorSidebarTarget}
                    blankProject={blankProject} workspaceId={project.id} projectRoot={project.rootPath} hosts={hosts}
                    stateOf={host => presentAgentHost(host, results[host.id], liveHostIds.has(host.id)).state}
                    selectedAppId={selectedHostId} onSelectApp={chooseHost} installing={installing} notes={notes} locateNotices={locateNotices}
                    onInstall={host => { void installHost(host) }} onRemove={host => { void removeHost(host) }}
                    onLocate={host => { void locateHost(host) }} onClearOverride={host => { void clearHostOverride(host) }}
                    rescanning={rescanning} onRescan={rescan} hostDiscoveryError={hostDiscoveryError}
                    onContinue={() => setActiveStep(2)} onOpenCanvas={onComplete} onChoice={setMappingChoice}
                    onStarted={(run, warning) => { setMappingRecord(null); movedToReview.current = false; setMappingState(null); setMappingWarning(warning ?? ''); setMappingRun(run); setActiveStep(2) }} />}
              </div>
            )}

            {activeStep === 2 && blankProject && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 2 of 2</p>
                <h2>Connect {selectedHost?.modalityLabel || selectedHost?.label || 'your agent'}</h2>
                {selectedVerified ? (
                  <>
                    <p className="ambio-connect__step-copy">
                      {selectedHost?.modalityLabel || selectedHost?.label} called Ambio from this project. The inbox connection is verified.
                    </p>
                    <div className="ambio-connect__waiting-line" data-state="connected" aria-live="polite">
                      <span aria-hidden="true" /> Inbox access verified
                    </div>
                  </>
                ) : selectedOnline ? (
                  <>
                    <p className="ambio-connect__step-copy">
                      {selectedHost?.modalityLabel || selectedHost?.label} is connected. Ask it to check that it can use Ambio before opening the canvas.
                    </p>
                    <div className="ambio-connect__command" data-kind="connection check">
                      <span>{connectionCheckPrompt(project)}</span>
                      <button type="button" onClick={() => void copyText(connectionCheckPrompt(project))}>{copied ? 'Copied ✓' : 'Copy check'}</button>
                    </div>
                    <div className="ambio-connect__waiting-line" aria-live="polite">
                      <span aria-hidden="true" /> Waiting for the agent to verify Ambio tools
                    </div>
                  </>
                ) : selectedReady ? (
                  <>
                    <p className="ambio-connect__step-copy">
                      {selectedHost?.restartDetail || 'Restart it and open a new session. Agents load MCP connections at startup.'}
                    </p>
                    <div className="ambio-connect__instruction-card">
                      <span aria-hidden="true">↻</span>
                      <p><strong>{selectedHost?.restartAction || 'Start fresh.'}</strong> Keep Ambio open while the agent connects.</p>
                    </div>
                    <div className="ambio-connect__waiting-line" aria-live="polite">
                      <span aria-hidden="true" /> Waiting for a live agent
                    </div>
                  </>
                ) : (
                  <p className="ambio-connect__step-copy">
                    Select an available agent and finish installing Ambio before restarting it.
                  </p>
                )}
                <StepActions
                  backLabel="Back to agents"
                  onBack={() => setActiveStep(1)}
                  nextLabel="Open canvas"
                  onNext={onComplete}
                  nextDisabled={!selectedVerified}
                />
              </div>
            )}

            {activeStep === 2 && !blankProject && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 2 of 3</p>
                {mappingRun ? (
                  <>
                    <h2>{readyForReview ? 'Project mapping is complete' : mappingRecord?.state === 'submitted' ? 'Closing the mapping session' : mappingRecord?.state === 'cancelled' ? 'Project mapping stopped' : `${mappingLabel} is mapping this project`}</h2>
                    <p className="ambio-connect__step-copy">Review opens after the complete map is submitted and the agent session has stopped.</p>
                    <MappingActivity run={mappingRun} onState={setMappingState} onSummary={setMappingSummary} onRetry={handleRetry} onDismiss={() => { setMappingRun(null); setActiveStep(1) }} />
                    {mappingWarning && <p className="ambio-map-with__error" role="status">{mappingWarning}</p>}
                  </>
                ) : (
                  <>
                    <h2>Start mapping</h2>
                    <p className="ambio-connect__step-copy">Select an agent in step 1 to begin mapping your project.</p>
                  </>
                )}
              </div>
            )}

            {activeStep === 3 && !blankProject && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 3 of 3</p>
                <h2>{readyForReview ? 'Your architecture is ready'
                  : mappingRun ? `${mappingLabel} is mapping this project`
                    : 'Start mapping in step 1'}</h2>
                <p className="ambio-connect__step-copy">
                  {readyForReview
                    ? 'Review its systems, nesting and file placement before anything becomes part of your map.'
                    : mappingRun
                      ? 'Review opens after the complete map is submitted and the agent session has stopped.'
                      : 'Choose an agent in step 1 to create a complete map.'}
                </p>
                {readyForReview
                  ? <button type="button" className="ambio-connect__review" onClick={() => { if (mappingRecord?.proposalId) useProposalStore.setState({ pinned: { workspaceId: project.id, id: mappingRecord.proposalId } }); onReview() }}>Review architecture →</button>
                  : mappingRun
                    ? <MappingActivity run={mappingRun} onState={setMappingState} onSummary={setMappingSummary} onRetry={handleRetry} onDismiss={() => { setMappingRun(null); setActiveStep(1) }} />
                    : null}
              </div>
            )}
          </section>

          <aside className="ambio-connect__mascot">
            <AgentMascot state={mascotState} caption={mascot.caption} hostLabel={mappingLabel || selectedHost?.modalityLabel || selectedHost?.label || 'agent'} />
            <div className="ambio-connect__connector-sidebar" ref={setConnectorSidebarTarget} />
          </aside>
        </div>

        {!blankProject && (
          <footer className="ambio-connect__footer">
            {activeStep > 1 ? (
              <button
                type="button"
                className="ambio-connect__secondary ambio-connect__footer-back"
                onClick={() => {
                  if (activeStep === 2) {
                    setActiveStep(1)
                  } else {
                    setActiveStep((activeStep - 1) as SetupStep)
                  }
                }}
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <button type="button" onClick={() => setConfirmSkipOpen(true)}>Open canvas without mapping</button>
          </footer>
        )}
      </main>

      {confirmSkipOpen && (
        <div className="ambio-create__scrim" onClick={() => setConfirmSkipOpen(false)}>
          <div
            className="ambio-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skip-mapping-title"
            onClick={event => event.stopPropagation()}
            tabIndex={-1}
          >
            <div className="ambio-remove-modal__head">
              <span className="ambio-remove-modal__kicker">OPEN WITHOUT MAPPING</span>
              <h3 id="skip-mapping-title">Are you sure?</h3>
              <button
                type="button"
                className="ambio-remove-modal__close"
                onClick={() => setConfirmSkipOpen(false)}
                aria-label="Cancel"
              >
                ×
              </button>
            </div>

            <p className="ambio-remove-modal__body">
              Opening the canvas without mapping is not the intended experience and is not recommended. Ambio works best when an agent maps your architecture first so your systems and components are understood.
            </p>

            <div className="ambio-remove-modal__actions">
              <button
                type="button"
                className="ambio-remove-modal__cancel"
                onClick={() => setConfirmSkipOpen(false)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="ambio-remove-modal__danger"
                onClick={() => {
                  setConfirmSkipOpen(false)
                  if (mappingRun) void stopMappingRun(mappingRun).then(onSkip).catch(error => setMappingWarning(String(error)))
                  else onSkip()
                }}
              >
                Open without mapping
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StepActions({
  backLabel,
  onBack,
  nextLabel,
  onNext,
  nextDisabled = false,
  hint,
}: {
  /** What is still needed before the next step, beside a disabled button. */
  hint?: string
  backLabel?: string
  onBack?: () => void
  nextLabel?: string
  onNext?: () => void
  nextDisabled?: boolean
}) {
  if (!onBack && !onNext) return null
  return (
    <div className="ambio-connect__step-actions">
      {hint && <span className="ambio-connect__step-hint">{hint}</span>}
      {onBack && <button type="button" className="ambio-connect__secondary" onClick={onBack}>{backLabel}</button>}
      {onNext && <button type="button" className="ambio-connect__primary" onClick={onNext} disabled={nextDisabled}>{nextLabel} →</button>}
    </div>
  )
}
