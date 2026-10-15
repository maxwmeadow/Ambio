import assert from 'node:assert/strict'
import test from 'node:test'
import { agentConnectionState, sortAgentConnections } from './agentConnectionsModel.ts'

const host = (id, facts = {}) => ({ id, detected: true, configured: false, unreadablePaths: [], workflowInstalled: false, ...facts })

test('an agent talking to Ambio is connected whatever its files say', () => {
  assert.equal(agentConnectionState(host('a'), [{ hostId: 'a' }]), 'live')
  assert.equal(agentConnectionState(host('a', { unreadablePaths: ['x'] }), [{ hostId: 'a' }]), 'live')
})

test('files decide the state of an agent that is not connected', () => {
  assert.equal(agentConnectionState(host('a', { configured: true, workflowInstalled: true }), []), 'installed')
  assert.equal(agentConnectionState(host('a', { configured: true }), []), 'repair')
  assert.equal(agentConnectionState(host('a', { unreadablePaths: ['mcp.json'] }), []), 'repair')
  assert.equal(agentConnectionState(host('a'), []), 'available')
  assert.equal(agentConnectionState(host('a', { detected: false }), []), 'missing')
  assert.equal(agentConnectionState(host('a', { detected: false, configured: true, workflowInstalled: true }), [{ hostId: 'b' }]), 'installed')
})

test('connected agents come first, then repairs, keeping the given order within a group', () => {
  const hosts = [
    host('missing', { detected: false }),
    host('available-1'),
    host('installed', { configured: true, workflowInstalled: true }),
    host('repair', { configured: true }),
    host('available-2'),
    host('live'),
  ]
  assert.deepEqual(sortAgentConnections(hosts, [{ hostId: 'live' }]).map(item => item.id),
    ['live', 'repair', 'installed', 'available-1', 'available-2', 'missing'])
})
