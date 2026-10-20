import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentHostInfo, ConnectionTestResult } from '../../../electron/preload'
import type { DeliveryHost } from '../../shared/agentDelivery'
import { archdApi } from '../archdEndpoint.ts'
import { agentConnectionState, sortAgentConnections, type AgentConnectionState, type AgentPresenceEntry } from './agentConnectionsModel.ts'
import '../styles/agentConnections.css'

/** For a CLI Ambio can start, installing only matters to the user's own sessions. */
const CLI_STATE_LABEL: Record<AgentConnectionState, string> = {
  live: 'Your own session is connected now',
  installed: 'Ambio can start it · your own sessions have Ambio too',
  repair: 'Ambio can start it · your own sessions\u2019 setup needs repair',
  available: 'Ambio can start it · not added to your own sessions',
  missing: 'Not found on this computer',
}

const STATE_LABEL: Record<AgentConnectionState, string> = {
  live: 'Connected now',
  installed: 'Installed · not connected right now',
  repair: 'Needs repair',
  available: 'Not installed',
  missing: 'Not found on this computer',
}

/**
 * Settings → Agents: the three ways an agent works with Ambio, each with what
 * it needs. Ambio chat needs a model service; agents Ambio runs need only
 * their CLI, and adding Ambio to them serves the user's own sessions; agents
 * in other apps need Ambio added and a restart. Connection tests live here.
 * It works with or without a project open; with one open it also covers that
 * project's own files and shows live connections.
 */
export function AgentConnections({ workspaceId, projectRoot, projectName, onGuidedSetup, chat }: {
  workspaceId?: string
  projectRoot?: string
  projectName?: string
  onGuidedSetup?: () => void
  /** Ambio chat's model services. */
  chat?: ReactNode
}) {
  const [hosts, setHosts] = useState<AgentHostInfo[] | null>(null)
  const [started, setStarted] = useState<DeliveryHost[]>([])
  const [presence, setPresence] = useState<AgentPresenceEntry[]>([])
  const [busy, setBusy] = useState('')
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [tests, setTests] = useState<Record<string, ConnectionTestResult>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [armed, setArmed] = useState('')
  const [showMissing, setShowMissing] = useState(false)
  const active = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const [items, targets] = await Promise.all([window.ambio.listAgentHosts(projectRoot), window.ambio.listDeliveryHosts().catch(() => [] as DeliveryHost[])])
      if (active.current) { setHosts(items); setStarted(targets.filter(target => target.route === 'run')) }
    } catch {
      if (active.current) setHosts(current => current ?? [])
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
  const shown = sorted.filter(host => agentConnectionState(host, presence) !== 'missing')
  const missing = sorted.filter(host => agentConnectionState(host, presence) === 'missing')

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
    const name = host.modalityLabel || host.label
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
          <span className="ambio-agent-connections__signal" aria-hidden="true" />
          <div className="ambio-agent-connections__identity">
            <strong>{name}</strong>
            <small>
              {(host.modality === 'cli' ? CLI_STATE_LABEL : STATE_LABEL)[state]}
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

  if (hosts === null) return <p className="ambio-settings__text">Looking for agents…</p>

  // A CLI belongs with the agents Ambio runs whether or not it is installed.
  const ownSessions = sorted.filter(host => host.modality === 'cli')
  const inApps = shown.filter(host => host.modality !== 'cli')
  const appsMissing = missing.filter(host => host.modality !== 'cli')
  // Terminal agents that ride on an editor's Ambio setup, started by Ambio.
  const companions = started.filter(target => !(hosts ?? []).some(host => host.id === target.id))

  return (
    <div className="ambio-agent-connections">
      {chat && <section id="ambio-agents-chat" className="ambio-agent-connections__kind" aria-labelledby="ambio-agents-chat-title">
        <h3 id="ambio-agents-chat-title">Ambio chat</h3>
        <p className="ambio-settings__text">Ambio&rsquo;s own agent. Connect your ChatGPT plan or add a model service with an API key; there is nothing else to install or open.</p>
        {chat}
      </section>}

      <section className="ambio-agent-connections__kind" aria-labelledby="ambio-agents-run-title">
        <h3 id="ambio-agents-run-title">Agents Ambio runs</h3>
        <p className="ambio-settings__text">Ambio starts these in your project when you send them a message. They only need to be installed and signed in. Adding Ambio to them as well lets your own sessions, outside Ambio, see your map and draw on it.</p>
        {ownSessions.length + companions.length > 0
          ? <ul className="ambio-agent-connections__list">
            {ownSessions.map(row)}
            {companions.map(target => <li key={target.id} className="ambio-agent-connections__host" data-state={target.available ? 'installed' : 'missing'} data-agent-host={target.id}>
              <div className="ambio-agent-connections__summary">
                <span className="ambio-agent-connections__signal" aria-hidden="true" />
                <div className="ambio-agent-connections__identity"><strong>{target.label}</strong><small>{target.available ? 'Ambio can start it' : 'Not found on this computer'}</small></div>
              </div>
            </li>)}
          </ul>
          : <p className="ambio-agent-connections__empty">No agent Ambio can start was found on this computer. Install Claude Code, Codex or GitHub Copilot CLI and sign in, then come back.</p>}
      </section>

      <section className="ambio-agent-connections__kind" aria-labelledby="ambio-agents-apps-title">
        <h3 id="ambio-agents-apps-title">Agents in other apps</h3>
        <p className="ambio-settings__text">These work in their own app. Add Ambio once and restart the app; its chat can then use your map and take messages from Ambio{workspaceId ? '' : '. Open a project to see which are connected now'}.</p>
        {inApps.length > 0
          ? <ul className="ambio-agent-connections__list">{inApps.map(row)}</ul>
          : <p className="ambio-agent-connections__empty">No supported app was found on this computer. If one is installed, find it under the list below and point Ambio at its configuration file.</p>}

        {appsMissing.length > 0 && (
          <>
            <button type="button" className="ambio-agent-connections__more" aria-expanded={showMissing} onClick={() => setShowMissing(value => !value)}>
              {showMissing ? 'Hide' : 'Show'} {appsMissing.length} app{appsMissing.length === 1 ? '' : 's'} not found on this computer
            </button>
            {showMissing && <ul className="ambio-agent-connections__list">{appsMissing.map(row)}</ul>}
          </>
        )}
      </section>

      {onGuidedSetup && (
        <div className="ambio-settings__row">
          <div>
            <strong>Guided setup</strong>
            <small>Walks through installing, restarting the agent and asking it to map {projectName ?? 'this project'}.</small>
          </div>
          <button type="button" className="ambio-settings__button" onClick={onGuidedSetup}>Open…</button>
        </div>
      )}
    </div>
  )
}
