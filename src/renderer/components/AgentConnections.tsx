import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentHostInfo, ConnectionTestResult } from '../../../electron/preload'
import { APP_CLIENTS, CLI_CLIENTS, type DeliveryHost } from '../../shared/agentDelivery'
import { discoveryRequest } from './agentDiscovery'
import { ConnectorLogo } from './ConnectorLogo'
import type { ModelServiceSetupRequest } from '../modelServiceNavigation'
import { archdApi } from '../archdEndpoint.ts'
import { agentConnectionState, sortAgentConnections, type AgentConnectionState, type AgentPresenceEntry } from './agentConnectionsModel.ts'
import '../styles/agentConnections.css'

const STATE_LABEL: Record<AgentConnectionState, string> = {
  live: 'Connected now',
  installed: 'Ambio added · not connected right now',
  repair: 'Needs repair',
  available: 'Ambio not added yet',
  missing: 'Not found on this computer',
}
const CONNECTION_TYPES = [
  { id: 'chat', label: 'Ambio chat' },
  { id: 'run', label: 'Ambio runs it' },
  { id: 'apps', label: 'In another app' },
] as const

/**
 * Settings → Agents: the three ways an agent works with Ambio, each with what
 * it needs. Ambio chat needs a model service; agents Ambio runs need only
 * their CLI, and adding Ambio to them serves the user's own sessions; agents
 * in other apps need Ambio added and a restart. Connection tests live here.
 * It works with or without a project open; with one open it also covers that
 * project's own files and shows live connections.
 */
export function AgentConnections({ workspaceId, projectRoot, projectName, onGuidedSetup, chat, setupRequest }: {
  workspaceId?: string
  projectRoot?: string
  projectName?: string
  onGuidedSetup?: () => void
  /** Ambio chat's model services. */
  chat?: ReactNode
  setupRequest?: ModelServiceSetupRequest
}) {
  const [category, setCategory] = useState<'chat' | 'run' | 'apps'>(chat ? 'chat' : 'run')
  const [selected, setSelected] = useState<Record<string, string>>({})
  useEffect(() => { if (setupRequest) setCategory('chat') }, [setupRequest])
  const [hosts, setHosts] = useState<AgentHostInfo[] | null>(null)
  const [started, setStarted] = useState<DeliveryHost[]>(() => CLI_CLIENTS.map(client => ({ ...client, route: 'run', available: false, detail: 'Not checked yet.' })))
  const [presence, setPresence] = useState<AgentPresenceEntry[]>([])
  const [busy, setBusy] = useState('')
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [tests, setTests] = useState<Record<string, ConnectionTestResult>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [armed, setArmed] = useState('')
  const [scanError, setScanError] = useState('')
  const active = useRef(true)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const [items, targets] = await Promise.all([discoveryRequest(() => window.ambio.listAgentHosts(projectRoot)), discoveryRequest(() => window.ambio.listDeliveryHosts())])
      if (active.current && generation.current === request) {
        setHosts(items)
        setStarted(CLI_CLIENTS.map(client => targets.find(target => target.id === client.id && target.route === 'run') ?? { ...client, route: 'run', available: false, detail: 'CLI not found.' }))
        setScanError('')
      }
    } catch {
      if (active.current && generation.current === request) { setHosts(current => current ?? []); setScanError('Could not refresh agent installations. Retry the scan. Previous results may be out of date.') }
    }
    if (!workspaceId) { if (active.current) setPresence([]); return }
    try {
      const response = await fetch(`${archdApi()}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
      const body = response.ok ? await response.json() as { connections?: AgentPresenceEntry[] } : {}
      if (active.current) setPresence(body.connections ?? [])
    } catch {
      if (active.current) setPresence([])
    }
  }, [workspaceId, projectRoot])

  useEffect(() => {
    active.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 6000)
    return () => { active.current = false; clearInterval(timer) }
  }, [refresh])

  const sorted = useMemo(() => sortAgentConnections(hosts ?? [], presence), [hosts, presence])

  const executableAction = async (hostId: string, clear = false) => {
    setBusy(`executable:${hostId}`)
    try {
      const result = await (clear ? window.ambio.clearAgentExecutableOverride(hostId) : window.ambio.locateAgentExecutable(hostId))
      if (result.detail !== 'Cancelled.') setNotes(current => ({ ...current, [hostId]: { ok: result.ok, text: result.detail } }))
    } catch (error) { setNotes(current => ({ ...current, [hostId]: { ok: false, text: String(error) } })) }
    finally { setBusy(''); void refresh() }
  }
  const executableDetails = (target: DeliveryHost | undefined, id: string) => <div className="ambio-agent-connections__hint">
    {(target?.executablePath || target?.executableOverride) && <p>{target.executableOverride ? 'Your CLI location: ' : 'Found CLI: '}<code>{target.executablePath ?? target.executableOverride}</code></p>}
    {target?.discoveryError && <p role="alert">{target.discoveryError}</p>}
    <button type="button" className="ambio-agent-connections__link" disabled={!!busy} onClick={() => void executableAction(id)}>{target?.available ? 'Change executable…' : 'Locate executable…'}</button>
    {target?.executableOverride && <> · <button type="button" className="ambio-agent-connections__link" disabled={!!busy} onClick={() => void executableAction(id, true)}>Use automatic detection</button></>}
  </div>

  const act = async (host: AgentHostInfo, key: string, run: () => Promise<{ ok: boolean; detail: string }>, after?: string) => {
    setBusy(`${key}:${host.id}`); setArmed('')
    try {
      const result = await run()
      setNotes(current => ({ ...current, [host.id]: { ok: result.ok, text: result.ok && after ? `${result.detail} ${after}` : result.detail } }))
      if (result.ok) setTests(current => { const { [host.id]: _dropped, ...rest } = current; return rest })
    } catch (error) {
      setNotes(current => ({ ...current, [host.id]: { ok: false, text: error instanceof Error ? error.message : String(error) } }))
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const test = async (host: AgentHostInfo) => {
    setBusy(`test:${host.id}`)
    try {
      const result = await window.ambio.testAgentConnection(host.id, projectRoot)
      setTests(current => ({ ...current, [host.id]: result }))
      setOpen(current => ({ ...current, [host.id]: true }))
    } catch (error) {
      setNotes(current => ({ ...current, [host.id]: { ok: false, text: error instanceof Error ? error.message : String(error) } }))
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const row = (host: AgentHostInfo) => {
    const state = agentConnectionState(host, presence)
    const target = started.find(target => target.id === host.id)
    const name = host.modality === 'cli' ? CLI_CLIENTS.find(client => client.id === host.id)?.label ?? host.label : APP_CLIENTS.find(client => client.id === host.id)?.label ?? host.label
    const live = presence.filter(item => item.hostId === host.id)
    const verified = Math.max(0, ...live.map(item => item.lastToolAt ?? 0))
    const note = notes[host.id]
    const result = tests[host.id]
    const expanded = open[host.id] === true
    const working = (key: string) => busy === `${key}:${host.id}`
    const files: Array<{ label: string; path: string }> = [
      ...host.configuredPaths.map(path => ({ label: 'Connection', path })),
      ...host.unreadablePaths.map(path => ({ label: 'Unreadable', path })),
      ...(host.configured || host.unreadablePaths.length > 0 ? [] : [{ label: 'Would be written to', path: host.configPath }]),
      ...(host.workflowPath && host.workflowInstalled ? [{ label: 'Workflow', path: host.workflowPath }] : []),
    ]
    return (
      <li key={host.id} className="ambio-agent-connections__host" data-state={state} data-agent-host={host.id}>
        <div className="ambio-agent-connections__summary">
          <ConnectorLogo clientId={host.id} />
          <div className="ambio-agent-connections__identity">
            <strong>{name}</strong>
            <small>
              {host.modality === 'cli'
                ? scanError || !target ? 'Could not check CLI availability' : target.available ? 'CLI found · sign in before running' : target.discoveryError ? 'Could not use selected CLI' : 'CLI not found'
                : host.detectionError ? 'Could not fully check installation' : !host.detected && state !== 'live' ? host.configured ? 'Ambio added · app not found' : 'Not found on this computer' : STATE_LABEL[state]}
              {state === 'live' && live.length > 1 ? ` · ${live.length} sessions` : ''}
              {state === 'live' && (verified > 0
                ? ` · last tool call ${new Date(verified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ' · no tool call yet')}
              {state === 'repair' && host.unreadablePaths.length > 0 ? ' · its configuration file could not be read' : ''}
              {state === 'repair' && host.unreadablePaths.length === 0 ? ' · workflow or rule files are missing' : ''}
            </small>
            {host.sharedSurfaces.length > 0 && <small>Also covers {host.sharedSurfaces.map(surface => surface.label).join(', ')}</small>}
          </div>
          <div className="ambio-agent-connections__actions">
            {host.configured || host.unreadablePaths.length > 0 ? (
              <>
                <button type="button" className="ambio-settings__button" disabled={!!busy} onClick={() => void test(host)}>
                  {working('test') ? 'Testing…' : 'Test'}
                </button>
                <button type="button" className="ambio-settings__button" disabled={!!busy}
                  onClick={() => void act(host, 'install', () => window.ambio.installAgent(host.id, projectRoot), `${host.restartAction}: ${host.restartDetail}`)}>
                  {working('install') ? 'Repairing…' : 'Repair'}
                </button>
              </>
            ) : host.modality === 'cli' && state === 'missing' ? null : (
              <button type="button" className="ambio-settings__button ambio-agent-connections__primary" disabled={!!busy}
                title={host.modality === 'cli' ? `Lets your own ${name} sessions, outside Ambio, see your map and draw on it` : undefined}
                onClick={() => void act(host, 'install', () => window.ambio.installAgent(host.id, projectRoot), `${host.restartAction}: ${host.restartDetail}`)}>
                {working('install') ? 'Adding…' : host.modality === 'cli' ? 'Add to my sessions' : 'Add Ambio'}
              </button>
            )}
            <button type="button" className="ambio-agent-connections__disclose" aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} details for ${name}`}
              onClick={() => setOpen(current => ({ ...current, [host.id]: !expanded }))}>
              {expanded ? 'Less' : 'Details'}
            </button>
          </div>
        </div>

        {note && <p className={`ambio-agent-connections__note${note.ok ? '' : ' ambio-agent-connections__note--failed'}`} role="status">{note.text}</p>}
        {host.modality === 'cli' && executableDetails(target, host.id)}

        {expanded && (
          <div className="ambio-agent-connections__details">
            {result && (
              <section aria-label={`Test results for ${name}`}>
                <h4>
                  {result.ok ? 'Test passed' : 'Test found a problem'}
                  <time dateTime={new Date(result.testedAt).toISOString()}> · {new Date(result.testedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </h4>
                <ul className="ambio-agent-connections__checks">
                  {result.checks.map(check => (
                    <li key={check.id} data-state={check.state}><strong>{check.label}</strong><span>{check.detail}</span></li>
                  ))}
                  <li data-state={state === 'live' ? 'pass' : 'info'}>
                    <strong>Talking to Ambio now</strong>
                    <span>
                      {!workspaceId ? 'Open a project to see live connections.'
                        : state === 'live' ? `${name} is connected to ${projectName ?? 'this project'}${verified > 0 ? ' and has called a tool.' : ', but has not called a tool yet.'}`
                          : `${name} is not connected to ${projectName ?? 'this project'} right now. ${host.restartAction}: ${host.restartDetail}`}
                    </span>
                  </li>
                </ul>
              </section>
            )}

            <section aria-label={`Files for ${name}`}>
              <h4>Files</h4>
              {!!host.detectionEvidence?.length && <p className="ambio-agent-connections__hint">Found: <code>{host.detectionEvidence.join(', ')}</code></p>}
              {host.detectionError && <p role="alert">{host.detectionError}</p>}
              {host.connectionHostId && <p className="ambio-agent-connections__hint">Shares Ambio connection settings with {host.familyLabel}; its standalone CLI is a separate installation.</p>}
              <ul className="ambio-agent-connections__files">
                {files.map(file => (
                  <li key={`${file.label}:${file.path}`}>
                    <span>{file.label}</span>
                    <code title={file.path}>{file.path}</code>
                    <button type="button" className="ambio-agent-connections__link" onClick={() => window.ambio.showInFolder(file.path)}>Show</button>
                  </li>
                ))}
              </ul>
              {host.configOverride
                ? <p className="ambio-agent-connections__hint">You pointed Ambio at this configuration file yourself.{' '}
                  <button type="button" className="ambio-agent-connections__link" disabled={!!busy}
                    onClick={() => void act(host, 'locate', () => window.ambio.clearAgentHostOverride(host.id))}>Use the default location</button></p>
                : <p className="ambio-agent-connections__hint">Configuration somewhere else?{' '}
                  <button type="button" className="ambio-agent-connections__link" disabled={!!busy}
                    onClick={() => void act(host, 'locate', async () => {
                      const located = await window.ambio.locateAgentHost(host.id)
                      return located.detail === 'Cancelled.' ? { ok: true, detail: '' } : located
                    })}>Locate the file…</button></p>}
            </section>

            {(host.configured || host.workflowInstalled) && (
              <section className="ambio-agent-connections__remove">
                <button type="button"
                  className={armed === host.id ? 'ambio-settings__button ambio-settings__button--danger' : 'ambio-settings__button'}
                  disabled={!!busy}
                  onClick={() => {
                    if (armed !== host.id) { setArmed(host.id); return }
                    void act(host, 'remove', () => window.ambio.uninstallAgent(host.id, projectRoot))
                  }}>
                  {working('remove') ? 'Disconnecting…' : armed === host.id ? `Confirm: remove Ambio from ${name}` : 'Disconnect'}
                </button>
                <small>Removes Ambio's connection and workflow files from {name}. Nothing else in its settings changes.</small>
              </section>
            )}
          </div>
        )}
      </li>
    )
  }

  // A CLI belongs with the agents Ambio runs whether or not it is installed.
  const ownSessions = sorted.filter(host => host.modality === 'cli')
  const inApps = sorted.filter(host => host.modality !== 'cli')
  // Terminal agents that ride on an editor's Ambio setup, started by Ambio.
  const companions = started.filter(target => !(hosts ?? []).some(host => host.id === target.id))
  const clientPill = (group: 'run' | 'apps', id: string, label: string, status: string, tone: 'ready' | 'attention' | 'off', disabled = false) =>
    <button key={id} type="button" className="ambio-agent-connections__pill" data-tone={tone}
      aria-label={`${label} — ${status}`} title={status} aria-pressed={selected[group] === id} disabled={disabled}
      onClick={() => setSelected(current => ({ ...current, [group]: id }))}>
      <ConnectorLogo clientId={id} /><span>{label}</span>
    </button>
  const hostPill = (host: AgentHostInfo) => {
    const state = agentConnectionState(host, presence)
    const target = started.find(target => target.id === host.id)
    const label = host.modality === 'cli' ? CLI_CLIENTS.find(client => client.id === host.id)?.label ?? host.label : APP_CLIENTS.find(client => client.id === host.id)?.label ?? host.label
    const status = host.modality === 'cli' ? scanError || !target ? 'Could not check CLI availability' : target.discoveryError ? 'Could not use selected CLI' : target.available ? 'CLI found' : 'CLI not found'
      : host.detectionError ? 'Could not fully check installation' : !host.detected && state !== 'live' ? host.configured ? 'Ambio added · app not found' : 'Not found on this computer' : STATE_LABEL[state]
    const tone = host.modality === 'cli' ? target?.available ? 'ready' : target?.discoveryError || scanError ? 'attention' : 'off'
      : state === 'live' || state === 'installed' ? 'ready' : state === 'missing' ? 'off' : 'attention'
    return clientPill(host.modality === 'cli' ? 'run' : 'apps', host.id, label, status, tone)
  }

  return (
    <div className="ambio-agent-connections">
      <header className="ambio-agent-connections__page-heading">
        <div><h2>Agents</h2><p>Choose where your agent works. Manage its connection here.</p></div>
        {onGuidedSetup && <button type="button" className="ambio-agent-connections__link" onClick={onGuidedSetup}>Guided setup</button>}
      </header>
      <nav className="ambio-agent-connections__nav" aria-label="Agent connection types">
        {CONNECTION_TYPES.filter(item => chat || item.id !== 'chat').map(({ id, label }) =>
          <button key={id} type="button" aria-current={category === id ? 'page' : undefined} onClick={() => setCategory(id)}>{label}</button>)}
      </nav>
      {category !== 'chat' && <div className="ambio-agent-connections__toolbar">
        <span>{projectName ? `Project: ${projectName}` : 'Computer-wide connections'}</span>
        <button type="button" className="ambio-agent-connections__link" disabled={!!busy} onClick={() => void refresh()}>Rescan installations</button>
      </div>}
      {category !== 'chat' && scanError && <p role="alert">{scanError}</p>}
      {chat && <section id="ambio-agents-chat" className="ambio-agent-connections__kind" hidden={category !== 'chat'} aria-label="Ambio chat settings">
        {chat}
      </section>}

      <section className="ambio-agent-connections__kind" hidden={category !== 'run'} aria-labelledby="ambio-agents-run-title">
        <h3 id="ambio-agents-run-title">Agents Ambio runs</h3>
        <p className="ambio-settings__text">Ambio launches these CLIs in your project. Install one and sign in, then select it to check its location or connect your own terminal sessions.</p>
        {hosts === null && <p role="status">Checking installations…</p>}
        <div className="ambio-agent-connections__gallery" role="group" aria-label="CLI clients">
          {ownSessions.map(hostPill)}
          {companions.map(target => clientPill('run', target.id, target.label, target.available ? 'CLI found' : target.discoveryError ? 'Could not use selected CLI' : 'CLI not found', target.available ? 'ready' : target.discoveryError ? 'attention' : 'off'))}
        </div>
        {!selected.run && <p className="ambio-agent-connections__prompt">Select a client to manage its connection.</p>}
        <ul className="ambio-agent-connections__list">
            {ownSessions.filter(host => host.id === selected.run).map(row)}
            {companions.filter(target => target.id === selected.run).map(target => <li key={target.id} className="ambio-agent-connections__host" data-state={target.available ? 'installed' : 'missing'} data-agent-host={target.id}>
              <div className="ambio-agent-connections__summary">
                <ConnectorLogo clientId={target.id} />
                <div className="ambio-agent-connections__identity"><strong>{target.label}</strong><small>{target.available ? 'CLI found · sign in before running' : target.discoveryError ? 'Could not use selected CLI' : 'Not found on this computer'}</small></div>
              </div>
              {executableDetails(target, target.id)}
              {notes[target.id] && <p className="ambio-agent-connections__note" role="status">{notes[target.id].text}</p>}
            </li>)}
          </ul>
      </section>

      <section className="ambio-agent-connections__kind" hidden={category !== 'apps'} aria-labelledby="ambio-agents-apps-title">
        <h3 id="ambio-agents-apps-title">Agents in other apps</h3>
        <p className="ambio-settings__text">Connect Ambio to an editor or desktop app, then restart it. Its agent can use your map from that app.{!workspaceId && ' Open a project to check live connections.'}</p>
        {hosts === null && <p role="status">Checking installations…</p>}
        <div className="ambio-agent-connections__gallery" role="group" aria-label="External clients">
          {inApps.map(hostPill)}
          {APP_CLIENTS.filter(client => !inApps.some(host => host.id === client.id)).map(client => clientPill('apps', client.id, client.label, 'Could not check · rescan', 'attention', true))}
        </div>
        {!selected.apps && <p className="ambio-agent-connections__prompt">Select an app to manage its connection.</p>}
        <ul className="ambio-agent-connections__list">{inApps.filter(host => host.id === selected.apps).map(row)}</ul>
      </section>
    </div>
  )
}
