import assert from 'node:assert/strict'
import test from 'node:test'
import { discoveryRequest } from './agentDiscovery.ts'

test('an unresponsive discovery bridge times out, while synchronous and asynchronous failures are preserved', async () => {
  await assert.rejects(discoveryRequest(() => new Promise(() => {}), 15), /timed out/)
  await assert.rejects(discoveryRequest(() => { throw new Error('bridge missing') }), /bridge missing/)
  await assert.rejects(discoveryRequest(() => Promise.reject(new Error('IPC rejected'))), /IPC rejected/)
  assert.deepEqual(await discoveryRequest(() => Promise.resolve(['codex'])), ['codex'])
})
