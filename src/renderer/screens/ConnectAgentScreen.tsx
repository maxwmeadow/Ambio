import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'
import { AgentMascot } from '../components/AgentMascot'
import { useProposalDrafts } from '../components/ProposalDraftProgress'
import { MappingActivity, rememberedMappingRun, rememberMappingRun, type MappingChoice, type MappingRun, type MappingState, type MappingSummary } from './MapWithAgent'
import { useSheetStore } from '../store/sheetStore'
import { MAPPING_CONTRACT } from '../components/inboxModel'
import { ChooseAgent } from './ChooseAgent'
import { discoveryRequest } from '../components/agentDiscovery'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import {
  commandKind,
  connectionCheckPrompt,
  installOutcomeNote,
  presentAgentHost,
  type AgentHostState,
} from './connectAgentPresentation'
import { archdApi } from '../archdEndpoint.ts'
import { rememberSetupStep, rememberedSetupStep } from '../projectLocalState'

const RESCAN_MINIMUM_MS = 900

const POLL_MS = 2000

type Phase = 'waiting' | 'connected' | 'proposed'
type SetupStep = 1 | 2 | 3 | 4

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

interface AgentFamilyGroup {
  id: string
  label: string
  modalities: AgentHostInfo[]
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

const CODEBASE_APP_STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: 1, label: 'Choose agent' },
  { id: 2, label: 'Restart' },
  { id: 3, label: 'Map project' },
  { id: 4, label: 'Review' },
]

const progress = new Map<string, Phase>()

export function ConnectAgentScreen({
  project, fileCount, indexing, blankProject, backLabel = '← Projects', onComplete, onReview, onSkip, onBack,
}: Props) {
  // Reopening the project returns to the step it was left on.
  const [activeStep, setActiveStepState] = useState<SetupStep>(() => {
    const saved = rememberedSetupStep(project.id) ?? 1
    return Math.min(saved, blankProject ? 2 : 4) as SetupStep
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
  const [phase, setPhaseState] = useState<Phase>(() => progress.get(project.id) ?? 'waiting')
  // A mapping Ambio is running itself needs no install, restart or command.
  const [mappingRun, setMappingRun] = useState<MappingRun | null>(() => blankProject ? null : rememberedMappingRun(project.id))
  const [mappingState, setMappingState] = useState<MappingState | null>(null)
  const [mappingSummary, setMappingSummary] = useState<MappingSummary | null>(null)
  const retryMapping = useRef<(() => void) | null>(null)
  const handleRetry = useCallback(async () => {
    try {
      const draftsRes = await fetch(`${archdApi()}/api/architecture-proposal-drafts?workspace=${encodeURIComponent(project.id)}`).catch(() => null)
      if (draftsRes && draftsRes.ok) {
        const openDrafts = await draftsRes.json() as Array<{ sessionId: string }>
        for (const draft of openDrafts) {
          await fetch(`${archdApi()}/api/architecture-proposal-drafts/${encodeURIComponent(draft.sessionId)}/abort`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: project.id }),
          }).catch(() => {})
        }
      }
    } catch { /* ignore draft cleanup */ }

    if (retryMapping.current) {
      retryMapping.current()
      return
    }
    if (!mappingRun) return
    try {
      if (mappingRun.kind === 'run') {
        const brief = await window.ambio.mappingBrief()
        const messageId = crypto.randomUUID()
        await useSheetStore.getState().sendToAgent(project.id, `${MAPPING_CONTRACT}\n\n${brief}`, [], null, messageId, [], { threadId: messageId, mode: 'propose' })
        await window.ambio.deliverWorkOrder({ workspaceId: project.id, messageId, hostId: mappingRun.hostId, ...(mappingRun.model ? { model: mappingRun.model } : {}) })
        const newRun: MappingRun = { ...mappingRun, messageId }
        rememberMappingRun(newRun, project.id)
        setMappingState(null)
        setMappingRun(newRun)
      } else {
        const providers = await window.ambio.chatProviders().catch(() => [])
        const providerId = providers[0]?.id || 'anthropic'
        const brief = await window.ambio.mappingBrief()
        const conversation = await window.ambio.createChat(project.id, providerId, mappingRun.model)
        await window.ambio.sendChat({ conversationId: conversation.id, text: `${MAPPING_CONTRACT}\n\n${brief}`, mode: 'propose', ...(mappingRun.model ? { model: mappingRun.model } : {}) })
        const newRun: MappingRun = { kind: 'chat', workspaceId: project.id, conversationId: conversation.id, label: mappingRun.label, model: mappingRun.model }
        rememberMappingRun(newRun, project.id)
        setMappingState(null)
        setMappingRun(newRun)
      }
    } catch (e) {
      console.error('Retry failed', e)
    }
  }, [mappingRun, project.id])
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

  const setPhase = useCallback((next: Phase) => {
    const rank: Record<Phase, number> = { waiting: 0, connected: 1, proposed: 2 }
    const current = progress.get(project.id) ?? 'waiting'
    if (rank[next] <= rank[current]) return
    progress.set(project.id, next)
    setPhaseState(next)
  }, [project.id])

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

  // Group hosts by family
  const families: AgentFamilyGroup[] = useMemo(() => {
    const map = new Map<string, AgentFamilyGroup>()
    for (const host of hosts) {
      const fid = host.familyId || host.id
      const flabel = host.familyLabel || host.label
      const existing = map.get(fid)
      if (existing) {
        existing.modalities.push(host)
      } else {
        map.set(fid, { id: fid, label: flabel, modalities: [host] })
      }
    }
    return [...map.values()]
  }, [hosts])

  // A live presence response is the gate.
  useEffect(() => {
    const poll = async () => {
      const workspace = encodeURIComponent(project.id)
      if (!blankProject && phase !== 'proposed') {
        try {
          const res = await fetch(`${archdApi()}/api/architecture-proposals?workspace=${workspace}`)
          if (res.ok) {
            const body = await res.json() as unknown
            const list = Array.isArray(body) ? body : (body as { proposals?: unknown[] })?.proposals ?? []
            if (list.length > 0) setPhase('proposed')
          }
        } catch { /* the next poll retries */ }
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
          if (!blankProject && body.connected) setPhase('connected')
        }
      } catch { /* the next poll retries */ }

      if (!blankProject) {
        try {
          const res = await fetch(`${archdApi()}/api/agent/actions?workspace=${workspace}&limit=200`)
          if (!res.ok) return
          const body = await res.json() as unknown
          const list = (Array.isArray(body) ? body : (body as { actions?: unknown[] })?.actions ?? []) as unknown[]
          if (list.length > 0) setPhase('connected')
        } catch { /* the next poll retries */ }
      }
    }

    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [blankProject, phase, project.id, setPhase])

  // A mapping has started once the agent has saved its first chunk. That is
  // progress, not a proposal: the proposal exists when the agent finishes.
  const [mapping, setMapping] = useState(false)
  useEffect(() => {
    if (blankProject) return
    let active = true
    const check = async () => {
      try {
        const res = await fetch(`${archdApi()}/api/architecture-proposal-drafts?workspace=${encodeURIComponent(project.id)}`)
        if (!res.ok) return
        const drafts = await res.json() as Array<{ chunkCount: number }>
        if (active) setMapping(drafts.some(draft => draft.chunkCount > 0))
      } catch { /* the next poll retries */ }
    }
    const onDraft = () => { void check() }
    onDraft()
    const timer = setInterval(onDraft, POLL_MS)
    window.addEventListener('ambio:proposal-draft', onDraft)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('ambio:proposal-draft', onDraft)
    }
  }, [blankProject, project.id])

  const selectedHost = useMemo(
    () => hosts.find(host => host.id === selectedHostId) ?? hosts[0] ?? null,
    [hosts, selectedHostId],
  )

  const needsRestart = !blankProject && !mappingRun && mappingChoice?.kind === 'app'

  useEffect(() => {
    const maxStep = blankProject ? 2 : needsRestart ? 4 : 3
    if (activeStep > maxStep) setActiveStep(maxStep as SetupStep)
  }, [blankProject, needsRestart, activeStep, setActiveStep])

  // Advance to review when a proposed architecture arrives.
  const movedToReview = useRef(false)
  useEffect(() => {
    if (blankProject || movedToReview.current) return
    const mapStep = needsRestart ? 3 : 2
    const reviewStep = needsRestart ? 4 : 3
    if (activeStep !== mapStep) return
    if (mappingRun ? phase !== 'proposed' : !mapping && phase !== 'proposed') return
    movedToReview.current = true
    setActiveStep(reviewStep as SetupStep)
  }, [blankProject, activeStep, mapping, phase, setActiveStep, needsRestart, mappingRun])

  const selectedFamily = useMemo(() => {
    if (!selectedHost) return families[0] ?? null
    return families.find(f => f.id === selectedHost.familyId) ?? null
  }, [families, selectedHost])

  // The mascot follows the chosen agent, in that agent's terms: an agent Ambio
  // runs is ready without connecting; one in another app waits for its chat.
  const otherAppName = selectedHost?.modalityLabel || selectedHost?.label || 'your agent'
  const otherAppInstalled = !!selectedHost && selectedHost.configured && selectedHost.workflowInstalled
  const mappingLabel = mappingRun ? (mappingRun.kind === 'chat' ? 'Ambio chat' : mappingRun.label) : ''
  const mappingActive = !!mappingRun && (mappingState === null || mappingState === 'working' || mappingState === 'waiting')
  const mascot: { state: 'sleeping' | 'connected' | 'proposal-ready'; caption?: string } =
    !blankProject && phase === 'proposed' ? { state: 'proposal-ready' }
      : mappingActive ? { state: 'connected', caption: mappingState === 'waiting' ? `Waiting - ${mappingLabel} needs your answer.` : `Working - ${mappingLabel} is mapping the project.` }
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
    if (phase === 'proposed') {
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
  }, [mappingRun, mappingLabel, phase, mappingState, mappingSummary])

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
    if (needsRestart) {
      if (step === 1) return !!selectedHost && (results[selectedHost.id]?.ok || selectedHost.configured)
      if (step === 2) return phase !== 'waiting' || activeStep > 2
      if (step === 3) return phase === 'proposed' || activeStep > 3
      return false
    }
    if (step === 1) return !!mappingRun || (!!mappingChoice && mappingChoice.available !== false)
    if (step === 2) return phase === 'proposed' || activeStep > 2
    return false
  }

  const stepLabels = blankProject ? BLANK_PROJECT_STEPS
    : needsRestart ? CODEBASE_APP_STEPS : CODEBASE_STEPS


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
                  ? <div className="ambio-connect__scroll"><MappingActivity run={mappingRun} onState={setMappingState} onSummary={setMappingSummary} onRetry={retryMapping.current ?? undefined} onDismiss={() => setMappingRun(null)} /></div>
                  : <ChooseAgent
                    sidebarTarget={connectorSidebarTarget}
                    blankProject={blankProject} workspaceId={project.id} projectRoot={project.rootPath} hosts={hosts}
                    stateOf={host => presentAgentHost(host, results[host.id], liveHostIds.has(host.id)).state}
                    selectedAppId={selectedHostId} onSelectApp={chooseHost} installing={installing} notes={notes} locateNotices={locateNotices}
                    onInstall={host => { void installHost(host) }} onRemove={host => { void removeHost(host) }}
                    onLocate={host => { void locateHost(host) }} onClearOverride={host => { void clearHostOverride(host) }}
                    rescanning={rescanning} onRescan={rescan} hostDiscoveryError={hostDiscoveryError}
                    onContinue={() => setActiveStep(2)} onOpenCanvas={onComplete} onChoice={setMappingChoice}
                    onStarted={(run, warning, retry) => { setMappingState(null); setMappingWarning(warning ?? ''); retryMapping.current = retry ?? null; setMappingRun(run); setActiveStep(2) }} />}
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

            {activeStep === 2 && !blankProject && needsRestart && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 2 of 4</p>
                <h2>{selectedHost?.restartAction || `Restart ${selectedHost?.modalityLabel || selectedHost?.label}`}</h2>

                {/* Modality switcher if multiple are in this family */}
                {selectedFamily && selectedFamily.modalities.length > 1 && (
                  <div className="ambio-connect__step-tabs" role="tablist">
                    {selectedFamily.modalities.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        className="ambio-connect__step-tab"
                        data-selected={selectedHostId === m.id}
                        onClick={() => chooseHost(m.id)}
                      >
                        {m.modalityLabel || m.label}
                      </button>
                    ))}
                  </div>
                )}

                {selectedReady ? (
                  <>
                    <p className="ambio-connect__step-copy">
                      {selectedHost?.restartDetail || 'Close its existing session and open a new one. Agents load MCP connections and workflows at startup.'}
                    </p>
                    <div className="ambio-connect__instruction-card">
                      <span aria-hidden="true">↻</span>
                      <p><strong>{selectedHost?.restartAction || 'Restart'}:</strong> {selectedHost?.restartDetail}</p>
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
                  nextLabel="I restarted it"
                  onNext={() => setActiveStep(3)}
                />
              </div>
            )}

            {activeStep === 2 && !blankProject && !needsRestart && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 2 of 3</p>
                {mappingRun ? (
                  <>
                    <h2>{mappingRun.kind === 'chat' ? 'Ambio chat' : mappingRun.label} is mapping this{'\u00A0'}project</h2>
                    <p className="ambio-connect__step-copy">Review opens here when the agent says the map is done.</p>
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

            {activeStep === 3 && !blankProject && needsRestart && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 3 of 4</p>
                <h2>Ask {selectedHost?.modalityLabel || selectedHost?.label} to map this project</h2>

                {/* Modality switcher if multiple are in this family */}
                {selectedFamily && selectedFamily.modalities.length > 1 && (
                  <div className="ambio-connect__step-tabs" role="tablist">
                    {selectedFamily.modalities.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        className="ambio-connect__step-tab"
                        data-selected={selectedHostId === m.id}
                        onClick={() => chooseHost(m.id)}
                      >
                        {m.modalityLabel || m.label}
                      </button>
                    ))}
                  </div>
                )}

                {selectedHost?.triggerKind === 'chat prompt' ? (
                  <>
                    <p className="ambio-connect__step-copy">
                      In {selectedHost.modalityLabel || selectedHost.label}, paste this instruction into the chat:
                    </p>
                    <div className="ambio-connect__command" data-kind="chat prompt">
                      <span>{selectedHost.promptText || selectedHost.command}</span>
                      <button type="button" onClick={() => void copyText(selectedHost.promptText || selectedHost.command)}>
                        {copied ? 'Copied ✓' : 'Copy prompt'}
                      </button>
                    </div>
                    <p className="ambio-connect__command-note">
                      This prompts {selectedHost.modalityLabel || selectedHost.label} to use Ambio&apos;s tools to map the codebase.
                    </p>
                  </>
                ) : selectedHost?.command ? (
                  <>
                    <p className="ambio-connect__step-copy">
                      {selectedReady ? 'In the new session, run' : 'Once Ambio is installed, run'} this {commandKind(selectedHost.command, selectedHost.triggerKind)} exactly as shown.
                    </p>
                    <div className="ambio-connect__command" data-kind={commandKind(selectedHost.command, selectedHost.triggerKind)}>
                      <span>{selectedHost.command}</span>
                      <button type="button" onClick={() => void copyText(selectedHost.command)}>{copied ? 'Copied ✓' : 'Copy'}</button>
                    </div>
                    <p className="ambio-connect__command-note">
                      The workflow carries Ambio’s mapping brief. You do not need to paste any extra prompt.
                    </p>
                  </>
                ) : (
                  <p className="ambio-connect__step-copy">
                    {selectedHost?.modalityLabel || selectedHost?.label} is not ready yet. Return to step 1 and install or repair Ambio first.
                  </p>
                )}
                <StepActions
                  backLabel="Back"
                  onBack={() => setActiveStep(2)}
                  nextLabel="Continue to review"
                  onNext={() => setActiveStep(4)}
                />
              </div>
            )}

            {((activeStep === 3 && !blankProject && !needsRestart) || (activeStep === 4 && !blankProject && needsRestart)) && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">{needsRestart ? 'Step 4 of 4' : 'Step 3 of 3'}</p>
                <h2>{phase === 'proposed' ? 'Your architecture is ready'
                  : mappingRun ? `${mappingLabel} is mapping this project`
                    : mapping ? 'Your agent is mapping the project' : 'Wait for the proposal'}</h2>
                <p className="ambio-connect__step-copy">
                  {phase === 'proposed'
                    ? 'Review its systems, nesting and file placement before anything becomes part of your map.'
                    : mappingRun || mapping
                      ? 'Review opens here when the agent says the map is done.'
                      : hasLivePresence
                        ? `${selectedHost?.modalityLabel || selectedHost?.label} is connected. Review opens here when its map arrives.`
                        : 'Keep Ambio open while the agent maps the project.'}
                </p>
                {phase === 'proposed'
                  ? <button type="button" className="ambio-connect__review" onClick={onReview}>Review architecture →</button>
                  : mappingRun
                    ? <MappingActivity run={mappingRun} onState={setMappingState} onSummary={setMappingSummary} onRetry={handleRetry} onDismiss={() => { setMappingRun(null); setActiveStep(1) }} />
                    : <DraftLine workspaceId={project.id} />}
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
                    setMappingRun(null)
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
                  onSkip()
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

/** How far an agent in another app has got, in one line, with a way to drop its partial map. */
function DraftLine({ workspaceId }: { workspaceId: string }) {
  const drafts = useProposalDrafts(workspaceId, POLL_MS)
  return (
    <div className="ambio-connect__waiting-line" aria-live="polite">
      <span aria-hidden="true" />
      {drafts.newest ? `Mapping in progress · ${drafts.newest.systemCount} ${drafts.newest.systemCount === 1 ? 'system' : 'systems'} so far` : 'Waiting for the map to start'}
      {drafts.newest && <button type="button" className="ambio-choose__quiet" disabled={drafts.discarding} onClick={() => { void drafts.discard() }}>Discard partial map</button>}
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
