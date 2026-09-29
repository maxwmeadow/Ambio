import { useEffect, useState } from 'react'
import type { AgentHostInfo } from '../../../electron/preload'
import { archdApi } from '../archdEndpoint.ts'

type Connection = 'checking' | 'online' | 'live' | 'configured' | 'repair' | 'unconfigured' | 'unavailable'

export function AgentHandoff({ workspaceId, projectRoot, onManageConnections }: {
  workspaceId: string
  projectRoot: string
  onManageConnections?: () => void
}) {
  const [connection, setConnection] = useState<Connection>('checking')
  const [hostLabel, setHostLabel] = useState('')
  const [liveDescription, setLiveDescription] = useState('')

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const hosts = await window.axiom.listAgentHosts(projectRoot)
        const response = await fetch(`${archdApi()}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
        if (!response.ok) throw new Error('Presence unavailable')
        const presence = await response.json() as {
          connected?: boolean
          connections?: Array<{ hostId: string; lastToolAt?: number }>
        }
        if (!active) return
        const liveId = presence.connections?.find(item => item.hostId !== 'unknown')?.hostId
        const liveHost = hosts.find((host: AgentHostInfo) => host.id === liveId)
        const installedHost = hosts.find((host: AgentHostInfo) => host.configured && host.workflowInstalled)
        const configuredHost = hosts.find((host: AgentHostInfo) => host.configured)
        setHostLabel(liveHost?.label ?? installedHost?.label ?? configuredHost?.label ?? '')
        const counts = new Map<string, number>()
        for (const item of presence.connections ?? []) {
          const label = hosts.find((host: AgentHostInfo) => host.id === item.hostId)?.label ?? (item.hostId === 'unknown' ? 'Unknown host' : item.hostId)
          counts.set(label, (counts.get(label) ?? 0) + 1)
        }
        const hostSummary = [...counts].map(([label, count]) => count > 1 ? `${label} ×${count}` : label).join(', ')
        const verified = (presence.connections ?? []).filter(item => (item.lastToolAt ?? 0) > 0).length
        const total = presence.connections?.length ?? 0
        setLiveDescription(verified
          ? `Axiom tool access verified · ${verified}/${total} connections${hostSummary ? ` · ${hostSummary}` : ''}`
          : `${total} MCP process${total === 1 ? '' : 'es'} online · Run tool check${hostSummary ? ` · ${hostSummary}` : ''}`)
        setConnection(presence.connected ? (verified ? 'live' : 'online') : installedHost ? 'configured' : configuredHost ? 'repair' : 'unconfigured')
      } catch {
        if (active) setConnection('unavailable')
      }
    }
    void check()
    const timer = setInterval(() => { void check() }, 8000)
    return () => { active = false; clearInterval(timer) }
  }, [workspaceId, projectRoot])

  const status = connection === 'live' || connection === 'online' ? liveDescription
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
  </section>
}
