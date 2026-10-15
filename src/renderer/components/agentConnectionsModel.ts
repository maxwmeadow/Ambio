export type AgentConnectionState = 'live' | 'installed' | 'repair' | 'available' | 'missing'

export interface AgentPresenceEntry {
  hostId: string
  lastToolAt?: number
}

interface HostFacts {
  id: string
  detected: boolean
  configured: boolean
  unreadablePaths: string[]
  workflowInstalled: boolean
}

/**
 * One word for where an agent stands. Live wins over everything: an agent
 * that is talking to Ambio is connected whatever its files look like.
 */
export function agentConnectionState(host: HostFacts, presence: AgentPresenceEntry[]): AgentConnectionState {
  if (presence.some(item => item.hostId === host.id)) return 'live'
  if (host.unreadablePaths.length > 0) return 'repair'
  if (host.configured) return host.workflowInstalled ? 'installed' : 'repair'
  return host.detected ? 'available' : 'missing'
}

const ORDER: AgentConnectionState[] = ['live', 'repair', 'installed', 'available', 'missing']

/** Connected first, then what needs attention, then the rest; stable within each. */
export function sortAgentConnections<T extends HostFacts>(hosts: T[], presence: AgentPresenceEntry[]): T[] {
  return hosts
    .map((host, index) => ({ host, index, rank: ORDER.indexOf(agentConnectionState(host, presence)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.host)
}
