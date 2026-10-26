import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentHostInfo } from '../../../electron/preload'
import type { AgentHostState } from './connectAgentPresentation'
import { CHAT_SETUP, startMapping, useRunnableChoices, type MappingChoice, type MappingRun, type RunnableChoice } from './MapWithAgent'
import { openModelServices } from '../modelServiceNavigation'
import { AgentModelSelect, useAgentModel } from '../components/AgentModelMenu'
import { chatModels } from '../../shared/agentChat'
import { APP_CLIENTS, RUN_NEEDS_INSTALL } from '../../shared/agentDelivery'
import { ConnectorLogo } from '../components/ConnectorLogo'
import { InfoPopover } from '../components/ui/InfoPopover'

/**
 * Setup's first step: supported client pills grouped by connection type. Each route keeps
 * its own availability and setup; product marks are bundled for offline use.
 * The selected client's details open over the field agent without losing state.
 */

const APP_STATUS: Record<AgentHostState, string> = {
  live: 'Connected now',
  installed: 'Ambio added',
  repair: 'Needs repair',
  available: 'Ambio not added yet',
  missing: 'Not found',
}

export function ChooseAgent({
  sidebarTarget,
  blankProject, workspaceId, projectRoot, hosts, stateOf, selectedAppId, onSelectApp, installing, notes, locateNotices,
  onInstall, onRemove, onLocate, onClearOverride, rescanning, onRescan, onContinue, onOpenCanvas, onStarted, onChoice, hostDiscoveryError,
}: {
  sidebarTarget: HTMLDivElement | null
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
  onRescan: () => Promise<void>
  onContinue: () => void
  onOpenCanvas: () => void
  onStarted: (run: MappingRun, warning?: string, retry?: () => void) => void
  onChoice: (choice: MappingChoice) => void
  hostDiscoveryError?: string
}) {
  const discovery = useRunnableChoices()
  const sectionId = useId()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const selectedPill = useRef<HTMLButtonElement | null>(null)
  const closeSidebar = () => {
    setSidebarOpen(false)
    selectedPill.current?.focus()
  }
  useEffect(() => {
    // The field agent stacks below the choices on small screens.
    if (sidebarOpen && window.matchMedia('(max-width: 850px)').matches) sidebarTarget?.scrollIntoView({ block: 'nearest' })
  }, [sidebarOpen, sidebarTarget])
  const runnable = discovery.choices
  // CLIs are agents Ambio runs; only apps need Ambio added and a restart.
  const apps = useMemo(() => hosts.filter(host => host.modality !== 'cli'), [hosts])
  const foundApps = apps.filter(host => stateOf(host) !== 'missing')
  const [selection, setSelection] = useState<string | null>(null)
  const [addToSessions, setAddToSessions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Until the user picks, an agent Ambio can run now, else an app with Ambio, else the first app.
  const fallback = runnable.find(choice => choice.kind === 'chat' || choice.kind === 'run' && choice.host.available)?.id
    ?? runnable?.[0]?.id
    ?? (foundApps.find(host => stateOf(host) === 'live' || stateOf(host) === 'installed') ?? foundApps[0])?.id
    ?? null
  const chosen = selection && (runnable?.some(choice => choice.id === selection) || apps.some(host => host.id === selection))
    ? selection
    // A model service just added takes the place of the setup choice that asked for it.
    : selection === CHAT_SETUP ? runnable?.find(choice => choice.kind === 'chat')?.id ?? fallback : fallback
  const run = runnable?.find(choice => choice.id === chosen)
  const app = run ? undefined : apps.find(host => host.id === chosen)
  const appName = app ? APP_CLIENTS.find(client => client.id === app.id)?.label ?? app.label : ''
  const appState = app ? stateOf(app) : null

  // Later steps must follow the app actually shown as selected, including a default.
  useEffect(() => { if (app && app.id !== selectedAppId) onSelectApp(app.id) }, [app?.id, selectedAppId])
  useEffect(() => {
    onChoice(run ? { label: run.label, kind: run.kind, available: run.kind !== 'run' || run.host.available } : app ? { label: appName, kind: 'app', available: appState === 'installed' || appState === 'live' } : null)
  }, [run?.id, run?.kind === 'run' ? run.host.available : undefined, app?.id, appState])

  // The model the mapping runs with, remembered with the agent panel's choice for the same agent.
  const model = useAgentModel({
    key: run?.kind === 'run' ? run.host.id : run?.kind === 'chat' ? `chat:${run.provider.id}` : '',
    hostId: run?.kind === 'run' && run.host.available ? run.host.id : undefined,
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
      const selectedModel = model.value || undefined
      const doMap = async () => {
        const { run: started, warning } = await startMapping({
          choice,
          workspaceId,
          projectRoot,
          installer: offerInstall && addToSessions ? installer : undefined,
          required: mustInstall ? required : undefined,
          model: selectedModel,
        })
        onStarted(started, warning, doMap)
      }
      await doMap()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }

  const locateExecutable = async (clear = false) => {
    if (run?.kind !== 'run') return
    setBusy(true); setError('')
    try {
      const outcome = await (clear ? window.ambio.clearAgentExecutableOverride(run.host.id) : window.ambio.locateAgentExecutable(run.host.id))
      if (!outcome.ok && outcome.detail !== 'Cancelled.') setError(outcome.detail)
      if (outcome.ok) await discovery.refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }

  const option = (id: string, name: string, status: string, tone: 'ready' | 'attention' | 'off', disabled = false) =>
    <button key={id} type="button" role="radio" aria-checked={chosen === id} aria-label={`${name} — ${status}`} title={`${name} — ${status}`} tabIndex={chosen === id ? 0 : -1} className="ambio-choose__option" data-tone={tone} disabled={disabled || busy}
      aria-controls={sidebarOpen && chosen === id ? `${sectionId}-details` : undefined}
      onClick={event => {
        selectedPill.current = event.currentTarget
        if (chosen !== id) setError('')
        setSelection(id); setSidebarOpen(true)
      }}>
      <ConnectorLogo clientId={id} />
      <strong>{name}</strong>
      <span className="ambio-choose__status-text">{status}</span>
    </button>

  // A CLI that reaches Ambio only through its app says so until Ambio is added there.
  const runOption = (choice: Extract<RunnableChoice, { kind: 'run' }>) => {
    const { id, label, host } = choice
    const hostId = host.id
    if (host.discoveryError) return option(id, label, 'Could not check · select for details', 'attention')
    if (!host.available) return option(id, label, discovery.loading ? 'Checking…' : 'Not found', 'off')
    const app = RUN_NEEDS_INSTALL[hostId]
    const appHost = app ? hosts.find(host => host.id === app.installer) : undefined
    return app && appHost && !appHost.configured
      ? option(id, label, `Adds Ambio to ${app.app}`, 'attention')
      : option(id, label, 'On this computer', 'ready')
  }

  const appOption = (host: AgentHostInfo) => {
    const state = stateOf(host)
    const label = APP_CLIENTS.find(client => client.id === host.id)?.label ?? host.label
    const status = host.detectionError ? 'Could not fully check' : !host.detected && state !== 'live' ? host.configured ? 'Ambio added · app not found' : 'Not found' : APP_STATUS[state]
    return option(host.id, label, status, state === 'live' || state === 'installed' ? 'ready' : state === 'missing' ? 'off' : 'attention')
  }

  // The one next step for what is chosen.
  let detail: React.ReactNode = null
  let action: React.ReactNode = null
  if (run?.kind === 'setup') {
    action = <button type="button" className="ambio-connect__primary" onClick={() => openModelServices('chatgpt')}>Connect Ambio chat</button>
  } else if (run?.kind === 'run' && !run.host.available) {
    detail = <p>{run.host.discoveryError ?? `${run.label} was not found. Install the standalone CLI and sign in, or locate its executable if it is already installed.`}
      {run.id === 'codex' && ' The Codex IDE extension and desktop app have separate connectors.'}</p>
    action = <button type="button" className="ambio-connect__secondary" disabled={busy} onClick={() => void locateExecutable()}>Locate {run.label}…</button>
  } else if (run && blankProject) {
    detail = <p>Nothing to set up. Choose {run.label} in the agent panel when you send your first message.</p>
    action = <button type="button" className="ambio-connect__primary" onClick={onOpenCanvas}>Open canvas</button>
  } else if (run && mustInstall && needs && required) {
    detail = <div className="ambio-choose__required">
      <div className="ambio-choose__required-head">
        <strong>Ambio adds itself to {needs.app} first</strong>
        <InfoPopover className="ambio-choose__info" label={`About connecting through ${needs.app}`} title={`About ${needs.app} connection`}>
          <p>{run.label} reaches Ambio&rsquo;s tools through {needs.app}&rsquo;s settings.</p>
          <p>Mapping adds Ambio&rsquo;s server to <code>{required.configPath}</code>{needs.alsoChanges ? ` ${needs.alsoChanges}` : ''}, so your own {needs.app} sessions get Ambio too.</p>
          <p>Nothing else changes; remove it any time in Settings &rarr; Agents.</p>
        </InfoPopover>
      </div>

      <p>{run.label} connects to Ambio through {needs.app}. Ambio will configure {needs.app} automatically before mapping.</p>

    </div>
    action = <div className="ambio-choose__actions"><AgentModelSelect model={model} disabled={busy} /><button type="button" className="ambio-connect__primary" disabled={busy} onClick={() => { void map(run) }}>{busy ? 'Adding Ambio\u2026' : `Add Ambio and map with ${run.label}`}</button></div>
  } else if (run) {
    detail = run.kind === 'chat' ? <p>Uses {run.provider.name} · {run.provider.model}. Ambio starts it here and shows its progress. Nothing to install or restart.</p> : null
    action = <div className="ambio-choose__actions"><AgentModelSelect model={model} disabled={busy} /><button type="button" className="ambio-connect__primary" disabled={busy} onClick={() => { void map(run) }}>{busy ? 'Starting…' : `Map with ${run.label}`}</button></div>
  } else if (app && appState) {
    const working = installing === app.id
    const hasCommand = (app.triggerKind === 'slash command' || app.triggerKind === 'skill command') && app.command
    if (appState === 'missing') {
      detail = <p>{appName} was not found. If it is installed somewhere else, point Ambio at its configuration file.</p>
      action = <button type="button" className="ambio-connect__secondary" onClick={() => onLocate(app)}>Locate {appName}…</button>
    } else if (appState === 'available') {
      detail = <div className="ambio-choose__required">
        <div className="ambio-choose__required-head">
          <strong>Works inside {appName}</strong>
          <InfoPopover className="ambio-choose__info" label={`About ${appName} integration`} title={`About ${appName} integration`}>
            <p>Ambio installs its MCP server into {appName}&rsquo;s settings.</p>
            <p>You interact directly inside {appName}&rsquo;s chat rather than Ambio chat.</p>
            <p>When the agent uses Ambio&rsquo;s tools, your architecture map updates live in Ambio.</p>
            <p>Nothing else changes; remove it any time in Settings &rarr; Agents.</p>
          </InfoPopover>
        </div>
        <p>Ambio adds its tools and skills to {appName}. You will run {hasCommand ? <code>{app.command}</code> : 'its mapping prompt'} inside {appName} and look back at Ambio as your map is built.</p>
      </div>
      action = <button type="button" className="ambio-connect__primary" disabled={working} onClick={() => onInstall(app)}>{working ? 'Adding Ambio…' : `Add Ambio to ${appName}`}</button>
    } else if (appState === 'repair') {
      detail = <div className="ambio-choose__required">
        <div className="ambio-choose__required-head">
          <strong>Repair setup for {appName}</strong>
          <InfoPopover className="ambio-choose__info" label={`About ${appName} repair`} title={`About ${appName} repair`}>
            <p>Ambio&rsquo;s MCP configuration or skills in <code>{app.configPath}</code> need repair.</p>
            <p>Repairing restores Ambio&rsquo;s tools so {appName} can communicate with your project.</p>
            <p>Remove it any time in Settings &rarr; Agents.</p>
          </InfoPopover>
        </div>
        <p>Ambio&rsquo;s setup in {appName} is incomplete. Repair it to restore tools and skills, then restart {appName}.</p>
        <div>
          <button type="button" className="ambio-choose__quiet" disabled={working} onClick={() => onRemove(app)}>Remove Ambio from {appName}</button>
          {app.configOverride && <> <button type="button" className="ambio-choose__quiet" onClick={() => onClearOverride(app)}>Use the default location</button></>}
        </div>
      </div>
      action = <button type="button" className="ambio-connect__primary" disabled={working} onClick={() => onInstall(app)}>{working ? 'Working…' : `Repair Ambio in ${appName}`}</button>
    } else {
      detail = <div className="ambio-choose__required">
        <div className="ambio-choose__required-head">
          <strong>{appState === 'live' ? `Connected to ${appName}` : `Ready in ${appName}`}</strong>
          <InfoPopover className="ambio-choose__info" label={`About ${appName} integration`} title={`About ${appName} integration`}>
            <p>Ambio is configured in <code>{app.configPath}</code>.</p>
            <p>{app.restartDetail}</p>
            <p>Work directly in {appName}&rsquo;s chat. When the agent uses Ambio&rsquo;s tools, changes appear live on your canvas.</p>
            <p>Nothing else changes; remove it any time in Settings &rarr; Agents.</p>
          </InfoPopover>
        </div>
        <p>
          {blankProject
            ? `Restart ${appName} if it was open, then check the connection.`
            : <>Restart {appName} if it was open, then run {hasCommand ? <code>{app.command}</code> : 'its mapping prompt'} inside {appName} and look back at Ambio.</>}
        </p>
        <div>
          <button type="button" className="ambio-choose__quiet" disabled={working} onClick={() => onRemove(app)}>Remove Ambio from {appName}</button>
          {app.configOverride && <> <button type="button" className="ambio-choose__quiet" onClick={() => onClearOverride(app)}>Use the default location</button></>}
        </div>
      </div>
      action = <button type="button" className="ambio-connect__primary" onClick={onContinue}>Continue with {appName}</button>
    }
  }
  const note = app ? notes[app.id] ?? (locateNotices[app.id] ? { ok: true, text: locateNotices[app.id] } : undefined) : undefined

  return <>
    <div className="ambio-connect__scroll">
      <div className="ambio-choose" role="radiogroup" aria-label="Agents" onKeyDown={event => {
        if (event.key === 'Escape' && sidebarOpen) { event.preventDefault(); closeSidebar(); return }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        const pills = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
        const index = pills.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? pills.length - 1
          : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + pills.length) % pills.length
        event.preventDefault()
        pills[next].focus(); pills[next].click()
      }}>
        <section className="ambio-choose__section" aria-labelledby={`${sectionId}-chat`}>
          <h3 id={`${sectionId}-chat`} className="ambio-choose__heading">Ambio chat</h3>
          <div className="ambio-choose__pills">
            {runnable.map(choice => choice.kind === 'run' ? null
              : choice.kind === 'chat' ? option(choice.id, choice.label, `${choice.provider.auth === 'chatgpt' ? 'ChatGPT plan' : 'Your API key'} · ${choice.provider.name}`, 'ready')
                : option(choice.id, choice.label, 'Needs a connection', 'attention'))}
          </div>
        </section>
        <section className="ambio-choose__section" aria-labelledby={`${sectionId}-run`}>
          <h3 id={`${sectionId}-run`} className="ambio-choose__heading">Ambio runs it</h3>
          <div className="ambio-choose__pills">
            {runnable.map(choice => choice.kind === 'run' ? runOption(choice) : null)}
          </div>
        </section>
        <section className="ambio-choose__section" aria-labelledby={`${sectionId}-app`}>
          <h3 id={`${sectionId}-app`} className="ambio-choose__heading">In another app</h3>
          <div className="ambio-choose__pills">
            {APP_CLIENTS.map(client => {
              const host = apps.find(host => host.id === client.id)
              return host ? appOption(host) : option(client.id, client.label, 'Could not check · rescan', 'attention', true)
            })}
          </div>
        </section>
      </div>
      {discovery.error && <p className="ambio-choose__note" role="alert">{discovery.error}</p>}
      {hostDiscoveryError && <p className="ambio-choose__note" role="alert">{hostDiscoveryError}</p>}
      <div className="ambio-choose__more">
        <button type="button" className="ambio-choose__quiet" disabled={rescanning || discovery.loading} aria-busy={rescanning || discovery.loading} onClick={() => { void Promise.allSettled([onRescan(), discovery.refresh()]) }}>{rescanning || discovery.loading ? 'Looking…' : 'Rescan'}</button>
      </div>
    </div>
    {sidebarOpen && sidebarTarget && chosen && createPortal(<section
      id={`${sectionId}-details`} className="ambio-choose__sidebar" role="region" aria-labelledby={`${sectionId}-title`}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeSidebar() }
      }}>
      <header className="ambio-choose__sidebar-header">
        <ConnectorLogo clientId={chosen} />
        <div>
          {(!run || run.kind === 'run') && <p>{run ? 'Ambio runs it' : 'In another app'}</p>}
          <h3 id={`${sectionId}-title`}>{run?.label ?? appName}</h3>
        </div>
        <button type="button" className="ambio-choose__close" aria-label="Close connector details" onClick={closeSidebar}>×</button>
      </header>
      <div className="ambio-choose__detail" key={chosen}>
        {run?.kind === 'run' && <>
          <p>Ambio calls your local {run.label} installation directly and shows its progress here.</p>
          <p>It uses the subscription or API account you configure in {run.label}, where supported. Manage sign-in and billing in that client.</p>
        </>}
        {(run?.kind === 'chat' || run?.kind === 'setup') && <>
          <p>Ambio&rsquo;s most native experience: an agent built into your workspace.</p>
          <p><button type="button" className="ambio-choose__provider-link" onClick={() => openModelServices('chatgpt')}>Sign in with ChatGPT</button> to use your eligible plan&rsquo;s usage limits.</p>
          <p>Or use your own API key from <button type="button" className="ambio-choose__provider-link" onClick={() => openModelServices('openai')}>OpenAI</button>, <button type="button" className="ambio-choose__provider-link" onClick={() => openModelServices('anthropic')}>Anthropic</button>, <button type="button" className="ambio-choose__provider-link" onClick={() => openModelServices('google')}>Google</button>, or an <button type="button" className="ambio-choose__provider-link" onClick={() => openModelServices('compatible')}>OpenAI-compatible provider</button>.</p>
        </>}
        {detail}
        {note && <p className="ambio-choose__note" data-ok={note.ok} role="status">{note.text}</p>}
        {error && <p className="ambio-choose__note" data-ok="false" role="alert">{error}</p>}
        {app && <div className="ambio-choose__run-settings">
          <div className="ambio-choose__discovery">
            {app.detectionError && <p role="alert">{app.detectionError}</p>}
            {!!app.detectionEvidence?.length && <p>Found: <code>{app.detectionEvidence.join(', ')}</code></p>}
            <p>{app.configured ? 'Ambio connection: ' : 'Connection settings: '}<code>{app.configPath}</code></p>
            {app.connectionHostId && <p>Shares connection settings with {app.familyLabel}. This does not install its standalone CLI.</p>}
            {app.configOverride && <button type="button" className="ambio-choose__quiet" disabled={!!installing} onClick={() => onClearOverride(app)}>Use default location</button>}
            <button type="button" className="ambio-choose__quiet" disabled={!!installing} onClick={() => onLocate(app)}>Locate configuration…</button>
          </div>
        </div>}
        {run?.kind === 'run' && <div className="ambio-choose__run-settings">
          {run.host.available && offerInstall && !mustInstall && <div>
            <div className="ambio-choose__sessions-choice">
              <label className="ambio-choose__sessions">
                <input type="checkbox" checked={addToSessions} disabled={busy} onChange={event => setAddToSessions(event.target.checked)} />
                <span>Also add Ambio to your own {run.label} sessions <span className="ambio-choose__recommended">(Recommended)</span></span>
              </label>
              <InfoPopover className="ambio-choose__info" label={`About adding Ambio to your own ${run.label} sessions`} title="About your own CLI sessions">
                <p>Adds Ambio&rsquo;s connection and agent instructions to {run.label}. Sessions you start outside Ambio can then read and update your map and exchange messages with Ambio. Runs started here work without this option. Remove the connection any time in Settings &rarr; Agents.</p>
              </InfoPopover>
            </div>
          </div>}
          <div className="ambio-choose__discovery">
            {(run.host.executablePath || run.host.executableOverride) && <p>{run.host.executableOverride ? 'Your CLI location: ' : 'Found CLI: '}<code>{run.host.executablePath ?? run.host.executableOverride}</code></p>}
            {run.host.available && <button type="button" className="ambio-choose__quiet" disabled={busy} onClick={() => void locateExecutable()}>Change executable…</button>}
            {run.host.executableOverride && <button type="button" className="ambio-choose__quiet" disabled={busy} onClick={() => void locateExecutable(true)}>Use automatic detection</button>}
          </div>
        </div>}
      </div>
      <footer className="ambio-choose__footer" aria-label="Next step">{action}</footer>
    </section>, sidebarTarget)}
  </>
}
