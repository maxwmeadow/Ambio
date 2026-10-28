import assert from 'node:assert/strict'
import test from 'node:test'
import { MANUAL_DELIVERY, chooseDeliveryHost } from './agentDelivery.ts'
import { APP_CLIENTS, CLI_CLIENTS } from './agentDelivery.ts'
import { agentDriver } from '../../electron/agentDrivers.ts'

const host = (id, available = true) => ({ id, label: id, route: 'copy', available, detail: '' })
const hosts = [host('claude-code'), host('cursor'), host('codex', false)]

test('a new request starts where the last one in this project went', () => {
  assert.equal(chooseDeliveryHost({ hosts, remembered: 'cursor', liveIds: ['claude-code'], installedIds: ['claude-code'] }), 'cursor')
  assert.equal(chooseDeliveryHost({ hosts, remembered: MANUAL_DELIVERY, liveIds: ['claude-code'], installedIds: ['claude-code'] }), MANUAL_DELIVERY)
})

test('a remembered agent that can no longer receive falls back to a connected one', () => {
  assert.equal(chooseDeliveryHost({ hosts, remembered: 'codex', liveIds: [], installedIds: ['cursor'] }), 'cursor')
  assert.equal(chooseDeliveryHost({ hosts, remembered: 'gone', liveIds: ['cursor'], installedIds: [] }), 'cursor')
})

test('with no history, an agent connected now beats one that is only installed', () => {
  assert.equal(chooseDeliveryHost({ hosts, remembered: null, liveIds: ['cursor'], installedIds: ['claude-code', 'cursor'] }), 'cursor')
  assert.equal(chooseDeliveryHost({ hosts, remembered: null, liveIds: ['unknown'], installedIds: ['claude-code', 'cursor'] }), 'claude-code')
  assert.equal(chooseDeliveryHost({ hosts, remembered: null, liveIds: ['codex'], installedIds: ['codex'] }), MANUAL_DELIVERY)
})

test('with nothing set up, the handoff is copied by hand', () => {
  assert.equal(chooseDeliveryHost({ hosts, remembered: null, liveIds: [], installedIds: [] }), MANUAL_DELIVERY)
  assert.equal(chooseDeliveryHost({ hosts: [], remembered: 'cursor', liveIds: ['cursor'], installedIds: ['cursor'] }), MANUAL_DELIVERY)
})

test('an agent that only reaches Ambio through its app is blocked until Ambio is added there', async () => {
  const { deliveryReadiness, RUN_NEEDS_INSTALL } = await import('./agentDelivery.ts')
  const hosts = [
    { id: 'antigravity-cli', label: 'Antigravity CLI', route: 'run', available: true },
    { id: 'claude-code', label: 'Claude Code CLI', route: 'run', available: true },
  ]
  const readiness = installedIds => deliveryReadiness({ hostId: 'antigravity-cli', hosts, installedIds, watchers: 0, watchingHosts: [] })
  assert.equal(RUN_NEEDS_INSTALL['antigravity-cli'].installer, 'antigravity')
  assert.equal(readiness([]).tone, 'blocked')
  assert.match(readiness([]).text, /once Ambio is added to Antigravity/)
  assert.equal(readiness(['antigravity']).tone, 'ready')
  // Claude Code is handed Ambio's server on its command line: nothing to install.
  assert.equal(deliveryReadiness({ hostId: 'claude-code', hosts, installedIds: [], watchers: 0, watchingHosts: [] }).tone, 'ready')
})
test('setup and Settings classify launch support without depending on successful CLI discovery', () => {
  for (const { id } of CLI_CLIENTS) assert.ok(agentDriver(id), `shared launch capability lacks a driver: ${id}`)
  for (const id of ['grok', 'muse']) assert.ok(CLI_CLIENTS.some(client => client.id === id), id)
  for (const id of ['cursor', 'claude-desktop']) {
    assert.equal(CLI_CLIENTS.some(client => client.id === id), false)
    assert.ok(APP_CLIENTS.some(client => client.id === id), id)
  }
})
