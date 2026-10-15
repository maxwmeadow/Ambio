import assert from 'node:assert/strict'
import test from 'node:test'
import { MANUAL_DELIVERY, chooseDeliveryHost } from './agentDelivery.ts'

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
