import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHostInfo, ConnectionTestResult } from '../../../electron/preload'
import { archdApi } from '../archdEndpoint.ts'
import { agentConnectionState, sortAgentConnections, type AgentConnectionState, type AgentPresenceEntry } from './agentConnectionsModel.ts'
import '../styles/agentConnections.css'

const STATE_LABEL: Record<AgentConnectionState, string> = {
  live: 'Connected now',
  installed: 'Installed · not connected right now',
  repair: 'Needs repair',
  available: 'Not installed',
  missing: 'Not found on this computer',
}

/**
 * Agent connections: what Ambio is installed into, which agents are talking
 * to it right now, and the actions that fix one that is not. It lives in
 * Settings and works with or without a project open; with one open it also
 * covers that project's own files and shows live connections.
 */
export function AgentConnections({ workspaceId, projectRoot, projectName, onGuidedSetup }: {
  workspaceId?: string
  projectRoot?: string
  projectName?: string
  onGuidedSetup?: () => void
}) {
  const [hosts, setHosts] = useState<AgentHostInfo[] | null>(null)
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
      const items = await window.ambio.listAgentHosts(projectRoot)
      if (active.current) setHosts(items)
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
              {STATE_LABEL[state]}
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
            ) : (
              <button type="button" className="ambio-settings__button ambio-agent-connections__primary" disabled={!!busy}
                onClick={() => void act(host, 'install', () => window.ambio.installAgent(host.id, projectRoot), `${host.restartAction}: ${host.restartDetail}`)}>
                {working('install') ? 'Installing…' : 'Install'}
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

  const connected = shown.filter(host => agentConnectionState(host, presence) === 'live').length
  const installed = shown.filter(host => host.configured).length

  return (
    <div className="ambio-agent-connections">
      <p className="ambio-settings__text">
        {installed === 0
          ? 'Ambio is not installed in any agent yet. Install it into the ones you use; each then sees your map and can receive work orders.'
          : `Ambio is installed in ${installed} agent${installed === 1 ? '' : 's'}${workspaceId ? `, ${connected} connected to ${projectName ?? 'this project'} now` : ''}.`}
        {!workspaceId && ' Open a project to see which are connected and to set up its project files.'}
      </p>

      {shown.length > 0
        ? <ul className="ambio-agent-connections__list">{shown.map(row)}</ul>
        : <p className="ambio-agent-connections__empty">No supported agent was found on this computer. If one is installed, find it under the list below and point Ambio at its configuration file.</p>}

      {missing.length > 0 && (
        <>
          <button type="button" className="ambio-agent-connections__more" aria-expanded={showMissing} onClick={() => setShowMissing(value => !value)}>
            {showMissing ? 'Hide' : 'Show'} {missing.length} agent{missing.length === 1 ? '' : 's'} not found on this computer
          </button>
          {showMissing && <ul className="ambio-agent-connections__list">{missing.map(row)}</ul>}
        </>
      )}

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
