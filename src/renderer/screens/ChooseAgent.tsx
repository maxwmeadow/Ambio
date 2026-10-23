import { useEffect, useMemo, useState } from 'react'
import type { AgentHostInfo } from '../../../electron/preload'
import type { AgentHostState } from './connectAgentPresentation'
import { CHAT_SETUP, startMapping, useRunnableChoices, type MappingChoice, type MappingRun, type RunnableChoice } from './MapWithAgent'
import { OPEN_MODEL_SERVICES } from '../components/AgentChatPanel'
import { AgentModelSelect, useAgentModel } from '../components/AgentModelMenu'
import { chatModels } from '../../shared/agentChat'
import { canStartAgent, RUN_NEEDS_INSTALL } from '../../shared/agentDelivery'

/**
 * Setup's first step: one list of agents and one action for the one chosen.
 *
 * Agents Ambio runs come first, because they need nothing installed or
 * restarted; agents in other apps follow, each saying whether Ambio has been
 * added. Whatever is chosen, the footer carries the single next step for it.
 */

const APP_STATUS: Record<AgentHostState, string> = {
  live: 'Connected now',
  installed: 'Ambio added',
  repair: 'Needs repair',
  available: 'Ambio not added yet',
  missing: 'Not found',
}

export function ChooseAgent({
  blankProject, workspaceId, projectRoot, hosts, stateOf, selectedAppId, onSelectApp, installing, notes, locateNotices,
  onInstall, onRemove, onLocate, onClearOverride, rescanning, onRescan, onContinue, onOpenCanvas, onStarted, onChoice,
}: {
  blankProject: boolean
  workspaceId: string
  projectRoot: string
  hosts: AgentHostInfo[]
  stateOf: (host: AgentHostInfo) => AgentHostState
  selectedAppId: string | null
  onSelectApp: (hostId: string) => void
  installing: string | null
  notes: Record<string, { ok: boolean; text: string }>
  locateNotices: Record<string, string>
  onInstall: (host: AgentHostInfo) => void
  onRemove: (host: AgentHostInfo) => void
  onLocate: (host: AgentHostInfo) => void
  onClearOverride: (host: AgentHostInfo) => void
  rescanning: boolean
  onRescan: () => void
  onContinue: () => void
  onOpenCanvas: () => void
  onStarted: (run: MappingRun, warning?: string) => void
  onChoice: (choice: MappingChoice) => void
}) {
  const runnable = useRunnableChoices()
  // A terminal client can have MCP support without a launch driver.
  const apps = useMemo(() => hosts.filter(host => !canStartAgent(host.id)), [hosts])
  const foundApps = apps.filter(host => stateOf(host) !== 'missing')
  const missingApps = apps.filter(host => stateOf(host) === 'missing')
  const [showMissing, setShowMissing] = useState(false)
  const [selection, setSelection] = useState<string | null>(null)
  const [addToSessions, setAddToSessions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Automatic app preselection must not displace an agent Ambio can run.
  const fallback = runnable?.find(choice => choice.kind !== 'setup')?.id
    ?? (foundApps.some(host => host.id === selectedAppId) ? selectedAppId : null)
    ?? (foundApps.find(host => stateOf(host) === 'live' || stateOf(host) === 'installed') ?? foundApps[0])?.id
    ?? runnable?.[0]?.id ?? null
  const chosen = selection && (runnable?.some(choice => choice.id === selection) || apps.some(host => host.id === selection))
    ? selection
    // A model service just added takes the place of the setup choice that asked for it.
    : selection === CHAT_SETUP ? runnable?.find(choice => choice.kind === 'chat')?.id ?? fallback : fallback
  const run = runnable?.find(choice => choice.id === chosen)
  const app = run ? undefined : apps.find(host => host.id === chosen)
  const appName = app ? app.modalityLabel || app.label : ''
  const appState = app ? stateOf(app) : null

  // Only a click moves the later steps to another app; the screen's own pick (a connected one) stands otherwise.
  useEffect(() => { if (app && selection === app.id) onSelectApp(app.id) }, [app?.id, selection])
  useEffect(() => {
    onChoice(run ? { label: run.label, kind: run.kind } : app ? { label: appName, kind: 'app' } : null)
  }, [run?.id, app?.id])

  // The model the mapping runs with, remembered with the agent panel's choice for the same agent.
  const model = useAgentModel({
    key: run?.kind === 'run' ? run.host.id : run?.kind === 'chat' ? `chat:${run.provider.id}` : '',
    hostId: run?.kind === 'run' ? run.host.id : undefined,
    chatOptions: run?.kind === 'chat' ? chatModels(run.provider).map(id => ({ id, label: id })) : undefined,
  })
  // Adding Ambio to a CLI serves the user's own sessions; Ambio's runs do not need it.
  const installer = run?.kind === 'run' ? hosts.find(host => host.id === run.host.id && host.modality === 'cli') : undefined
  const offerInstall = !blankProject && !!installer && !(installer.configured && installer.workflowInstalled)
  // Some CLIs only reach Ambio through their app's settings: then adding Ambio
  // is part of mapping, not an option, and the screen says what it changes.
  const needs = run?.kind === 'run' ? RUN_NEEDS_INSTALL[run.host.id] : undefined
  const required = needs ? hosts.find(host => host.id === needs.installer) : undefined
  const mustInstall = !blankProject && !!needs && !!required && !required.configured

  const map = async (choice: Exclude<RunnableChoice, { kind: 'setup' }>) => {
    setBusy(true); setError('')
    try {
      const { run: started, warning } = await startMapping({ choice, workspaceId, projectRoot, installer: offerInstall && addToSessions ? installer : undefined, required: mustInstall ? required : undefined, model: model.value || undefined })
      onStarted(started, warning)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }

  const option = (id: string, name: string, status: string, tone: 'ready' | 'attention' | 'off', disabled = false) =>
    <button key={id} type="button" role="radio" aria-checked={chosen === id} className="ambio-choose__option" data-tone={tone} disabled={disabled || busy}
      onClick={() => setSelection(id)}>
      <span className="ambio-choose__radio" aria-hidden="true" />
      <strong>{name}</strong>
      <small>{status}</small>
    </button>

  // A CLI that reaches Ambio only through its app says so until Ambio is added there.
  const runOption = (id: string, label: string, hostId: string) => {
    const app = RUN_NEEDS_INSTALL[hostId]
    const appHost = app ? hosts.find(host => host.id === app.installer) : undefined
    return app && appHost && !appHost.configured
      ? option(id, label, `Adds Ambio to ${app.app}`, 'attention')
      : option(id, label, 'On this computer', 'ready')
  }

  const appOption = (host: AgentHostInfo) => {
    const state = stateOf(host)
    return option(host.id, host.modalityLabel || host.label, APP_STATUS[state], state === 'live' || state === 'installed' ? 'ready' : state === 'missing' ? 'off' : 'attention')
  }

  // The one next step for what is chosen.
  let detail: React.ReactNode = null
  let action: React.ReactNode = null
  if (run?.kind === 'setup') {
    detail = <p>Ambio chat uses your own API key with OpenAI, Anthropic, Google or a compatible service, and needs nothing installed.</p>
    action = <button type="button" className="ambio-connect__primary" onClick={() => window.dispatchEvent(new Event(OPEN_MODEL_SERVICES))}>Set up a model service</button>
  } else if (run && blankProject) {
    detail = <p>Nothing to set up. Choose {run.label} in the agent panel when you send your first message.</p>
    action = <button type="button" className="ambio-connect__primary" onClick={onOpenCanvas}>Open canvas →</button>
  } else if (run && mustInstall && needs && required) {
    detail = <div className="ambio-choose__required">
      <strong>Ambio adds itself to {needs.app} first</strong>
      <small>
        {run.label} reaches Ambio&rsquo;s tools only through {needs.app}&rsquo;s own settings. Map adds Ambio&rsquo;s server to <code>{required.configPath}</code>{needs.alsoChanges ? ` ${needs.alsoChanges}` : ''}, so your own {needs.app} sessions get Ambio too. Nothing else changes; remove it any time in Settings &rarr; Agents.
      </small>
    </div>
    action = <div className="ambio-choose__actions"><AgentModelSelect model={model} disabled={busy} /><button type="button" className="ambio-connect__primary" disabled={busy} onClick={() => { void map(run) }}>{busy ? 'Adding Ambio\u2026' : `Add Ambio and map with ${run.label} \u2192`}</button></div>
  } else if (run) {
    detail = offerInstall
      ? <label className="ambio-choose__sessions">
        <input type="checkbox" checked={addToSessions} disabled={busy} onChange={event => setAddToSessions(event.target.checked)} />
        <span><strong>Also add Ambio to your own {run.label} sessions</strong>
          <small>Recommended: your sessions outside Ambio can then see this map and draw on it. Remove it any time in Settings → Agents.</small></span>
      </label>
      : <p>{run.kind === 'chat' ? `Uses ${run.provider.name} · ${run.provider.model}. ` : ''}Ambio starts it here and shows its progress. Nothing to install or restart.</p>
    action = <div className="ambio-choose__actions"><AgentModelSelect model={model} disabled={busy} /><button type="button" className="ambio-connect__primary" disabled={busy} onClick={() => { void map(run) }}>{busy ? 'Starting…' : `Map with ${run.label} →`}</button></div>
  } else if (app && appState) {
    const working = installing === app.id
    const next = blankProject ? 'check the connection' : 'ask it to map the project'
    detail = <p>
      {appState === 'missing' ? `${appName} was not found. If it is installed somewhere else, point Ambio at its configuration file.`
        : appState === 'available' ? `Add Ambio to ${appName}, restart it, then ${next}.`
          : appState === 'repair' ? `Ambio's setup in ${appName} is incomplete. Repair it, then restart ${appName}.`
            : `Restart ${appName} if it was open, then ${next}.`}
      {(appState === 'installed' || appState === 'live' || appState === 'repair') && <> <button type="button" className="ambio-choose__quiet" disabled={working} onClick={() => onRemove(app)}>Remove Ambio from {appName}</button></>}
      {app.configOverride && <> <button type="button" className="ambio-choose__quiet" onClick={() => onClearOverride(app)}>Use the default location</button></>}
    </p>
    action = appState === 'missing'
      ? <button type="button" className="ambio-connect__secondary" onClick={() => onLocate(app)}>Locate {appName}…</button>
      : appState === 'available' || appState === 'repair'
        ? <button type="button" className="ambio-connect__primary" disabled={working} onClick={() => onInstall(app)}>{working ? 'Working…' : appState === 'repair' ? `Repair Ambio in ${appName}` : `Add Ambio to ${appName}`}</button>
        : <button type="button" className="ambio-connect__primary" onClick={onContinue}>Continue with {appName} →</button>
  }
  const note = app ? notes[app.id] ?? (locateNotices[app.id] ? { ok: true, text: locateNotices[app.id] } : undefined) : undefined

  return <>
    <div className="ambio-connect__scroll">
      <div className="ambio-choose" role="radiogroup" aria-label="Agents">
        <div className="ambio-choose__group">
          <h3>Ambio runs it <span>Nothing to restart</span></h3>
          {runnable === null ? <p className="ambio-choose__empty">Looking for agents…</p>
            : runnable.map(choice => choice.kind === 'run' ? runOption(choice.id, choice.label, choice.host.id)
              : choice.kind === 'chat' ? option(choice.id, choice.label, `Your API key · ${choice.provider.name}`, 'ready')
                : option(choice.id, choice.label, 'Needs your API key', 'attention'))}
        </div>
        <div className="ambio-choose__group">
          <h3>In another app <span>Add Ambio once, then start a fresh app or terminal session</span></h3>
          {foundApps.map(appOption)}
          {!showMissing && missingApps.filter(host => host.id === chosen).map(appOption)}
          {showMissing && missingApps.map(appOption)}
          <div className="ambio-choose__more">
            {missingApps.length > 0 && <button type="button" className="ambio-choose__quiet" aria-expanded={showMissing} onClick={() => setShowMissing(value => !value)}>
              {showMissing ? 'Hide' : 'Show'} {missingApps.length} not found on this computer
            </button>}
            <button type="button" className="ambio-choose__quiet" disabled={rescanning} aria-busy={rescanning} onClick={onRescan}>{rescanning ? 'Looking…' : 'Rescan'}</button>
          </div>
        </div>
      </div>
    </div>
    <footer className="ambio-choose__footer" aria-label="Next step" data-required={mustInstall && run ? '' : undefined}>
      <div className="ambio-choose__detail">
        {detail}
        {note && <p className="ambio-choose__note" data-ok={note.ok} role="status">{note.text}</p>}
        {error && <p className="ambio-choose__note" data-ok="false" role="alert">{error}</p>}
      </div>
      {action}
    </footer>
  </>
}
