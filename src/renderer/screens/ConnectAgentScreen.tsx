import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'
import { AgentMascot } from '../components/AgentMascot'
import { ProposalDraftProgress } from '../components/ProposalDraftProgress'
import { MapWithAgent, MappingActivity, rememberedMappingRun, type MappingRun } from './MapWithAgent'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import {
  AGENT_STATE_LABEL,
  commandKind,
  connectionCheckPrompt,
  familySummary,
  installOutcomeNote,
  orderAgentFamilies,
  presentAgentHost,
  type AgentHostState,
} from './connectAgentPresentation'
import { archdApi } from '../archdEndpoint.ts'
import { rememberSetupStep, rememberedSetupStep } from '../projectLocalState'

// Each surface states its own condition in two or three words. The full
// sentence stays on the dot's tooltip, where it does not crowd the row.
const RESCAN_MINIMUM_MS = 900

function surfaceTooltip(host: AgentHostInfo, state: AgentHostState): string {
  switch (state) {
    case 'live':
    case 'installed':
      return `Configured in ${host.configPath}`
    case 'repair':
      return host.unreadablePaths.length > 0
        ? `Ambio could not read ${host.unreadablePaths.join(', ')}, so it will not overwrite it.`
        : `Ambio is configured in ${host.configPath}, but its mapping or inbox workflow is missing.`
    case 'available':
      return `Found on this machine. Ambio will write to ${host.configPath}`
    default:
      return `Not found on this machine. Ambio looked for ${host.configPath}. `
        + 'Already have this installed? It may live somewhere Ambio does not check yet - use Rescan after opening it once.'
  }
}

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
  const [toggledFamilies, setToggledFamilies] = useState<Record<string, boolean>>({})
  const [showMissing, setShowMissing] = useState(false)
  // One line under a surface after an install or a removal, and one under a
  // family when installing all of it failed.
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [rescanning, setRescanning] = useState(false)
  const [locateNotices, setLocateNotices] = useState<Record<string, string>>({})
  const [hasLivePresence, setHasLivePresence] = useState(false)
  const [liveHostIds, setLiveHostIds] = useState<Set<string>>(() => new Set())
  const [verifiedHostIds, setVerifiedHostIds] = useState<Set<string>>(() => new Set())
  const [phase, setPhaseState] = useState<Phase>(() => progress.get(project.id) ?? 'waiting')
  // A mapping Ambio is running itself needs no install, restart or command.
  const [mappingRun, setMappingRun] = useState<MappingRun | null>(() => blankProject ? null : rememberedMappingRun(project.id))
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userSelectedHost = useRef(false)

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

  useEffect(() => {
    void window.ambio.listAgentHosts(project.rootPath).then(showHosts)
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [project.rootPath, showHosts])

  useEffect(() => {
    if (userSelectedHost.current || liveHostIds.size === 0) return
    const liveHost = hosts.find(host => liveHostIds.has(host.id))
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

  // The first chunk moves the screen on from "ask your agent" to the review
  // step by itself. Once only, so Back to the command is not undone.
  const movedToReview = useRef(false)
  useEffect(() => {
    if (blankProject || movedToReview.current || activeStep !== 3) return
    if (!mapping && phase !== 'proposed') return
    movedToReview.current = true
    setActiveStep(4)
  }, [blankProject, activeStep, mapping, phase, setActiveStep])

  const selectedHost = useMemo(
    () => hosts.find(host => host.id === selectedHostId) ?? hosts[0] ?? null,
    [hosts, selectedHostId],
  )

  const selectedFamily = useMemo(() => {
    if (!selectedHost) return families[0] ?? null
    return families.find(f => f.id === selectedHost.familyId) ?? null
  }, [families, selectedHost])

  const mascotState = !blankProject && phase === 'proposed'
    ? 'proposal-ready'
    : hasLivePresence || mappingRun
      ? 'connected'
      : 'sleeping'

  const selectedPresentation = selectedHost
    ? presentAgentHost(selectedHost, results[selectedHost.id], liveHostIds.has(selectedHost.id))
    : null

  const selectedReady = selectedPresentation?.state === 'installed' || selectedPresentation?.state === 'live'
  const selectedOnline = !!selectedHost && liveHostIds.has(selectedHost.id)
  const selectedVerified = !!selectedHost && verifiedHostIds.has(selectedHost.id)

  const rescan = useCallback(async () => {
    setRescanning(true)
    const startedAt = Date.now()
    try {
      showHosts(await window.ambio.listAgentHosts(project.rootPath))
    } finally {
      // Scanning is a handful of existsSync calls and finishes far too fast to
      // see. Without a floor the button appears inert, and the user cannot
      // tell a completed scan from a dead control.
      const remaining = RESCAN_MINIMUM_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      setRescanning(false)
    }
  }, [showHosts, project.rootPath])

  // Detection is guesswork about paths; this is how a user corrects it.
  const locateHost = useCallback(async (host: AgentHostInfo) => {
    const outcome = await window.ambio.locateAgentHost(host.id)
    if (outcome.ok) {
      setLocateNotices(previous => ({ ...previous, [host.id]: outcome.detail }))
      showHosts(await window.ambio.listAgentHosts(project.rootPath))
      return
    }
    // A cancelled dialog is not an error worth reporting back.
    if (outcome.detail !== 'Cancelled.') {
      setLocateNotices(previous => ({ ...previous, [host.id]: outcome.detail }))
    }
  }, [showHosts, project.rootPath])

  const clearHostOverride = useCallback(async (host: AgentHostInfo) => {
    const outcome = await window.ambio.clearAgentHostOverride(host.id)
    setLocateNotices(previous => ({ ...previous, [host.id]: outcome.detail }))
    showHosts(await window.ambio.listAgentHosts(project.rootPath))
  }, [showHosts, project.rootPath])

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
      if (outcome.ok) showHosts(await window.ambio.listAgentHosts(project.rootPath))
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
      showHosts(await window.ambio.listAgentHosts(project.rootPath))
    } finally {
      setInstalling(null)
    }
  }

  // One install for every surface of a family that is on this computer and
  // does not have Ambio yet. Each of those surfaces then says its own next
  // step; a failure is said once, on the family.
  const installFamily = async (family: AgentFamilyGroup) => {
    const targets = family.modalities.filter(modality =>
      presentAgentHost(modality, results[modality.id], liveHostIds.has(modality.id)).state === 'available')
    setInstalling(family.id)
    try {
      const outcome = await window.ambio.installFamily(family.id, project.rootPath)
      if (outcome.ok) {
        setResults(current => ({ ...current, ...Object.fromEntries(targets.map(target => [target.id, outcome])) }))
        setNotes(current => {
          const { [family.id]: _cleared, ...rest } = current
          return { ...rest, ...Object.fromEntries(targets.map(target => [target.id, installOutcomeNote(target, 'install', outcome)])) }
        })
        showHosts(await window.ambio.listAgentHosts(project.rootPath))
      } else {
        setNotes(current => ({ ...current, [family.id]: { ok: false, text: outcome.detail } }))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not install into these agents.'
      setNotes(current => ({ ...current, [family.id]: { ok: false, text: detail } }))
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
    if (mappingRun && (step === 1 || step === 2)) return true
    if (step === 1) {
      return hosts.some(host => {
        const state = presentAgentHost(host, results[host.id], liveHostIds.has(host.id)).state
        return state === 'installed' || state === 'live'
      })
    }
    if (step === 2) return blankProject ? selectedVerified : phase !== 'waiting'
    if (step === 3) return phase === 'proposed'
    return false
  }

  // A mapping Ambio runs skips the restart; the step says so rather than claiming one happened.
  const stepLabels = blankProject ? BLANK_PROJECT_STEPS
    : mappingRun ? CODEBASE_STEPS.map(step => step.id === 2 ? { ...step, label: 'No restart needed' } : step) : CODEBASE_STEPS

  const orderedFamilies = orderAgentFamilies(families, results, liveHostIds)
  const missingCount = orderedFamilies.filter(item => item.presentation.state === 'missing').length
  const readyHosts = hosts.filter(host => {
    const state = presentAgentHost(host, results[host.id], liveHostIds.has(host.id)).state
    return state === 'installed' || state === 'live'
  })

  // One surface of an agent: its state and the one thing to do about it.
  // `family` is given when the surface is the family's only one and so takes
  // the family's row.
  const renderSurface = (modality: AgentHostInfo, family?: AgentFamilyGroup) => {
    const pres = presentAgentHost(modality, results[modality.id], liveHostIds.has(modality.id))
    const busy = installing === modality.id
    const name = modality.modalityLabel || modality.label
    const ready = pres.state === 'installed' || pres.state === 'live'
    const note = notes[modality.id]
    const install = () => { chooseHost(modality.id); void installHost(modality) }
    return (
      <div
        key={modality.id}
        className={family ? 'ambio-connect__surface ambio-connect__surface--solo' : 'ambio-connect__surface'}
        data-state={pres.state}
        data-agent-surface={modality.id}
      >
        {family ? (
          <span
            className="ambio-connect__host-signal"
            data-state={pres.state}
            data-tooltip={surfaceTooltip(modality, pres.state)}
            aria-label={`${family.label}: ${AGENT_STATE_LABEL[pres.state]}`}
          />
        ) : (
          <span className="ambio-connect__modality-dot" data-state={pres.state} title={surfaceTooltip(modality, pres.state)} />
        )}
        <span className="ambio-connect__surface-label">
          {family ? <strong>{family.label}</strong> : name}
          {modality.sharedSurfaces.length > 0 && (
            <small>Also covers {modality.sharedSurfaces.map(surface => surface.label).join(' and ')}</small>
          )}
        </span>
        <span className="ambio-connect__surface-actions">
          {pres.state !== 'available' && (
            <span className="ambio-connect__surface-state">{AGENT_STATE_LABEL[pres.state]}</span>
          )}
          {ready && readyHosts.length > 1 && (
            selectedHost?.id === modality.id
              ? <span className="ambio-connect__surface-chosen">Setting up with this</span>
              : <button type="button" className="ambio-connect__quiet" onClick={() => chooseHost(modality.id)}>Use this one</button>
          )}
          {(pres.state === 'available' || pres.state === 'repair') && (
            <button type="button" className="ambio-connect__install" disabled={busy} onClick={install}>
              {busy ? 'Working…' : pres.state === 'repair' ? 'Repair' : 'Install'}
            </button>
          )}
          {ready && (
            <button type="button" className="ambio-connect__quiet" disabled={busy}
              title={`Write Ambio's connection and workflow files for ${name} again`} onClick={install}>
              {busy ? 'Working…' : 'Repair'}
            </button>
          )}
          {(ready || pres.state === 'repair') && (
            <button type="button" className="ambio-connect__quiet" disabled={busy}
              title={`Remove Ambio's connection and workflow from ${name}`} onClick={() => void removeHost(modality)}>
              Remove
            </button>
          )}
          {/* "Not found" should never be the end of the conversation - the
              tool may simply live somewhere Ambio does not know. */}
          {modality.configOverride ? (
            <button type="button" className="ambio-connect__quiet" onClick={() => void clearHostOverride(modality)}>Clear</button>
          ) : pres.state === 'missing' ? (
            <button type="button" className="ambio-connect__quiet" onClick={() => void locateHost(modality)}>Locate…</button>
          ) : null}
        </span>

        {modality.configOverride && (
          <span className="ambio-connect__surface-override">Using {modality.configOverride}</span>
        )}
        {locateNotices[modality.id] && (
          <span className="ambio-connect__surface-override">{locateNotices[modality.id]}</span>
        )}
        {note && <p className="ambio-connect__install-result" data-ok={note.ok} role="status">{note.text}</p>}
      </div>
    )
  }

  const renderFamily = ({ family, presentation }: ReturnType<typeof orderAgentFamilies<AgentFamilyGroup>>[number]) => {
    if (family.modalities.length === 1) {
      return (
        <li key={family.id} className="ambio-connect__family-card" data-state={presentation.state}>
          {renderSurface(family.modalities[0], family)}
        </li>
      )
    }
    const available = family.modalities.filter(modality =>
      presentAgentHost(modality, results[modality.id], liveHostIds.has(modality.id)).state === 'available').length
    const expanded = toggledFamilies[family.id] ?? (presentation.state === 'available' || presentation.state === 'repair')
    const familyNote = notes[family.id]
    return (
      <li key={family.id} className="ambio-connect__family-card" data-state={presentation.state} data-expanded={expanded}>
        <button
          type="button"
          className="ambio-connect__family-row"
          aria-expanded={expanded}
          aria-controls={`surfaces-${family.id}`}
          onClick={() => setToggledFamilies(previous => ({ ...previous, [family.id]: !expanded }))}
        >
          <span
            className="ambio-connect__host-signal"
            data-state={presentation.state}
            data-tooltip={presentation.detail}
            aria-label={`${family.label} status: ${presentation.detail}`}
          />
          <strong>{family.label}</strong>
          <span className="ambio-connect__family-summary">{familySummary(presentation, available)}</span>
          <span className="ambio-connect__family-chevron" aria-hidden="true" />
        </button>

        {expanded && (
          <div id={`surfaces-${family.id}`} className="ambio-connect__surfaces">
            {family.modalities.map(modality => renderSurface(modality))}
            {(available > 1 || familyNote) && (
              <div className="ambio-connect__surfaces-footer">
                {familyNote && <p className="ambio-connect__install-result" data-ok={familyNote.ok} role="status">{familyNote.text}</p>}
                {available > 1 && (
                  <button
                    type="button"
                    className="ambio-connect__install ambio-connect__install--batch"
                    disabled={installing === family.id}
                    onClick={() => void installFamily(family)}
                  >
                    {installing === family.id ? 'Working…' : `Install all ${available}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </li>
    )
  }

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
                <p className="ambio-connect__step-copy">
                  {blankProject
                    ? 'Ambio chat and agents Ambio runs need no setup. An agent in another app needs Ambio added to it once.'
                    : 'Let Ambio run an agent for you, or use one in another app.'}
                </p>

                <div className="ambio-connect__scroll">
                  {blankProject
                    ? <section className="ambio-map-with" aria-label="Agents that need no setup">
                      <h3>Ambio chat and agents Ambio runs</h3>
                      <p className="ambio-map-with__copy">Nothing to install. Open the canvas and choose one in the agent panel when you send your first message.</p>
                      <div className="ambio-map-with__row"><button type="button" className="ambio-connect__primary" onClick={onComplete}>Open canvas</button></div>
                    </section>
                    : mappingRun
                      ? <MappingActivity run={mappingRun} onDismiss={() => setMappingRun(null)} />
                      : <MapWithAgent workspaceId={project.id} projectRoot={project.rootPath} agentHosts={hosts} onStarted={run => { setMappingRun(run); setActiveStep(3) }} />}
                  <h3 className="ambio-connect__other">{blankProject ? 'Or connect an agent in another app' : 'Or use an agent in another app'}</h3>
                  <p className="ambio-connect__other-copy">Add Ambio to it here, restart it, then {blankProject ? 'check the connection' : 'ask it to map the project'}. Adding Ambio also lets your own sessions of an agent use your map.</p>
                  <ul className="ambio-connect__families" aria-label="Supported agents">
                    {orderedFamilies.filter(item => item.presentation.state !== 'missing').map(renderFamily)}
                  </ul>
                  {orderedFamilies.every(item => item.presentation.state === 'missing') && hosts.length > 0 && (
                    <p className="ambio-connect__none-found">
                      No supported agent was found on this computer. Install one, then rescan, or open the list below
                      and point Ambio at its configuration file.
                    </p>
                  )}

                  <div className="ambio-connect__list-bar">
                    {orderedFamilies.some(item => item.presentation.state === 'missing') ? (
                      <button
                        type="button"
                        className="ambio-connect__more"
                        aria-expanded={showMissing}
                        onClick={() => setShowMissing(value => !value)}
                      >
                        {showMissing ? 'Hide' : 'Show'} {missingCount} not found on this computer
                      </button>
                    ) : <span />}
                    <button
                      type="button"
                      className="ambio-connect__rescan"
                      onClick={() => void rescan()}
                      disabled={rescanning}
                      aria-label="Rescan"
                      aria-busy={rescanning}
                      title="Look again for agents on this computer"
                    >
                      <span className="ambio-connect__rescan-label" data-busy={rescanning}>
                        Rescan
                      </span>
                      {rescanning && (
                        <span className="ambio-connect__rescan-spinner" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  {showMissing && (
                    <ul className="ambio-connect__families" aria-label="Agents not found on this computer">
                      {orderedFamilies.filter(item => item.presentation.state === 'missing').map(renderFamily)}
                    </ul>
                  )}
                </div>

                {!mappingRun && <StepActions
                  hint={selectedReady ? undefined : 'Add Ambio to an agent in another app to continue that way.'}
                  nextLabel={selectedReady ? `Continue with ${selectedHost?.modalityLabel || selectedHost?.label}` : 'Continue'}
                  onNext={() => setActiveStep(2)}
                  nextDisabled={!selectedReady}
                />}
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

            {activeStep === 2 && !blankProject && mappingRun && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 2 of 4</p>
                <h2>Nothing to restart</h2>
                <p className="ambio-connect__step-copy">Ambio runs {mappingRun.label} for you, so there is nothing to install or restart.</p>
                <StepActions backLabel="Back" onBack={() => setActiveStep(1)} nextLabel="Follow the mapping" onNext={() => setActiveStep(3)} />
              </div>
            )}

            {activeStep === 2 && !blankProject && !mappingRun && (
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

            {activeStep === 3 && !blankProject && mappingRun && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 3 of 4</p>
                <h2>{mappingRun.kind === 'chat' ? 'Ambio chat' : mappingRun.label} is mapping this project</h2>
                <p className="ambio-connect__step-copy">You can watch it work here. The map arrives in parts; review opens when the agent says it is done.</p>
                <MappingActivity run={mappingRun} onDismiss={() => { setMappingRun(null); setActiveStep(1) }} />
                <ProposalDraftProgress workspaceId={project.id} inline />
                <StepActions backLabel="Back" onBack={() => setActiveStep(1)} nextLabel="Continue to review" onNext={() => setActiveStep(4)} />
              </div>
            )}

            {activeStep === 3 && !blankProject && !mappingRun && (
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

            {activeStep === 4 && !blankProject && (
              <div className="ambio-connect__step-panel">
                <p className="ambio-connect__step-kicker">Step 4 of 4</p>
                <h2>{phase === 'proposed' ? 'Your architecture is ready' : mapping ? 'Your agent is mapping the project' : 'Wait for the proposal'}</h2>
                <p className="ambio-connect__step-copy">
                  {phase === 'proposed'
                    ? 'Your agent finished mapping the codebase. Review its systems, nesting, and file placement before anything becomes canonical.'
                    : mapping
                      ? 'The first part of the map has arrived. The proposal is not ready until the agent says it is done; the button to review it appears here when it does.'
                      : hasLivePresence
                        ? `${selectedHost?.modalityLabel || selectedHost?.label} is connected and working. Ambio will light this step when the proposal arrives.`
                        : 'Keep Ambio open while the agent maps the project. You can return to any earlier step without losing progress.'}
                </p>
                {phase === 'proposed' ? (
                  <button type="button" className="ambio-connect__review" onClick={onReview}>Review architecture →</button>
                ) : (
                  <div className="ambio-connect__waiting-line" aria-live="polite">
                    <span aria-hidden="true" /> {mapping ? 'Mapping in progress · still waiting for the proposal' : 'Waiting for a mapping proposal'}
                  </div>
                )}
                {mappingRun && phase !== 'proposed' && <MappingActivity run={mappingRun} onDismiss={() => { setMappingRun(null); setActiveStep(1) }} />}
                <ProposalDraftProgress workspaceId={project.id} inline />
                <StepActions backLabel="Back" onBack={() => setActiveStep(3)} />
              </div>
            )}
          </section>

          <aside className="ambio-connect__mascot">
            <AgentMascot state={mascotState} hostLabel={mappingRun?.label || selectedHost?.modalityLabel || selectedHost?.label || 'agent'} />
          </aside>
        </div>

        {!blankProject && (
          <footer className="ambio-connect__footer">
            <span />
            <button type="button" onClick={onSkip}>Open canvas without mapping</button>
          </footer>
        )}
      </main>
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
