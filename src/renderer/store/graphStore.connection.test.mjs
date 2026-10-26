import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { connectToArchd, useGraphStore } from './graphStore.ts'

const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate() }
const snapshot = id => ({ workspaceId: id, systems: [], files: [], infraNodes: [], dependencies: [] })

test('async snapshot loading replays buffered updates and an old connection cannot publish into a new project', async () => {
  const before = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, setTimeout: globalThis.setTimeout }
  const sockets = [], requests = []
  globalThis.WebSocket = class {
    constructor() { sockets.push(this) }
    close() { this.onclose?.() }
  }
  // No real network or persistent background timers belong to this fixture.
  globalThis.setTimeout = (callback, ms, ...args) => ms === 250 ? 0 : before.setTimeout(callback, ms, ...args)
  globalThis.fetch = async url => {
    if (String(url).includes('/api/snapshot/')) return await new Promise(resolve => requests.push({ url, resolve }))
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    useGraphStore.getState().setCurrentProject({ id: 'first' })
    connectToArchd('ws://snapshot-fixture/ws'); sockets[0].onopen(); await flush()
    sockets[0].onmessage({ data: JSON.stringify({ seq: 1, type: 'indexing:progress', payload: { indexed: 7, total: 9 } }) })
    assert.equal(useGraphStore.getState().indexingProgress, null)
    requests[0].resolve(new Response(JSON.stringify(snapshot('first')))); await flush()
    assert.deepEqual(useGraphStore.getState().indexingProgress, { indexed: 7, total: 9 })

    // Pause inside body decoding, where the old reader used to keep working
    // after a workspace switch. A generation guard alone must not leak a job.
    sockets[0].onmessage({ data: JSON.stringify({ type: 'workspace:invalidate' }) }); await flush()
    let release
    requests[1].resolve({ ok: true, arrayBuffer: () => new Promise(resolve => { release = resolve }) }); await flush()
    useGraphStore.getState().setCurrentProject({ id: 'second' })
    connectToArchd('ws://snapshot-fixture/ws'); sockets[1].onopen(); await flush()
    const current = snapshot('second'); current.files = [{ id: 'current', relPath: 'current.ts' }]
    requests[2].resolve(new Response(JSON.stringify(current))); await flush()
    release(new TextEncoder().encode(JSON.stringify(snapshot('first'))).buffer); await flush()
    assert.equal(useGraphStore.getState().currentProject.id, 'second')
    assert.equal(useGraphStore.getState().files[0].id, 'current')
  } finally {
    useGraphStore.getState().setCurrentProject(null)
    connectToArchd('ws://snapshot-fixture/closed') // invalidate all fixture callbacks
    Object.assign(globalThis, before)
  }
})
