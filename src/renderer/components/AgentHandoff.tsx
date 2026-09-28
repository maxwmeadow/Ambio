import { useEffect, useState } from 'react'
import type { AgentHostInfo } from '../../../electron/preload'
import { InboxIcon } from './InboxIcon'

type Connection = 'checking' | 'live' | 'configured' | 'repair' | 'unconfigured' | 'unavailable'

function handoffPrompt(projectName: string): string {
  return `Check the Axiom inbox for the project "${projectName}". Read each queued instruction and its attached canvas or sheet context, do the requested work, and reply through Axiom. Stop when the inbox is empty.`
}

export function AgentHandoff({ workspaceId, projectRoot, projectName, queued, onManageConnections }: {
  workspaceId: string
  projectRoot: string
  projectName: string
  queued: number
  onManageConnections?: () => void
}) {
  const [connection, setConnection] = useState<Connection>('checking')
  const [hostLabel, setHostLabel] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const hosts = await window.axiom.listAgentHosts(projectRoot)
        const response = await fetch(`http://127.0.0.1:7743/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
        if (!response.ok) throw new Error('Presence unavailable')
        const presence = await response.json() as {
          connected?: boolean
          connections?: Array<{ hostId: string }>
        }
        if (!active) return
        const liveId = presence.connections?.find(item => item.hostId !== 'unknown')?.hostId
        const liveHost = hosts.find((host: AgentHostInfo) => host.id === liveId)
        const installedHost = hosts.find((host: AgentHostInfo) => host.configured && host.workflowInstalled)
        const configuredHost = hosts.find((host: AgentHostInfo) => host.configured)
        setHostLabel(liveHost?.label ?? installedHost?.label ?? configuredHost?.label ?? '')
        setConnection(presence.connected ? 'live' : installedHost ? 'configured' : configuredHost ? 'repair' : 'unconfigured')
      } catch {
        if (active) setConnection('unavailable')
      }
    }
    void check()
    const timer = setInterval(() => { void check() }, 8000)
    return () => { active = false; clearInterval(timer) }
  }, [workspaceId, projectRoot])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(handoffPrompt(projectName))
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }
  const status = connection === 'live' ? `${hostLabel || 'Agent'} MCP connected`
    : connection === 'configured' ? `${hostLabel || 'Agent'} configured · not connected`
      : connection === 'repair' ? `${hostLabel || 'Agent'} setup needs repair`
        : connection === 'unconfigured' ? 'No known local agent setup'
        : connection === 'unavailable' ? 'Connection status unavailable'
          : 'Checking agent connection…'

  return <section className="axiom-inbox__handoff" aria-label="Agent connection and handoff">
    <div className="axiom-inbox__handoff-status"><span className={`axiom-inbox__signal axiom-inbox__signal--${connection}`} />
      <span>{status}</span>
      {onManageConnections && <button type="button" onClick={onManageConnections}>Connections</button>}
    </div>
    {queued > 0 && <div className="axiom-inbox__handoff-next">
      <span><strong>{queued} queued.</strong> Saved in Axiom; an agent must check the inbox to receive {queued === 1 ? 'it' : 'them'}.</span>
      <button type="button" onClick={() => void copy()}><InboxIcon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy prompt for agent chat'}</button>
      {copyFailed && <p>Select and copy this prompt: {handoffPrompt(projectName)}</p>}
    </div>}
  </section>
}
