import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeCanvasSnapshot } from './snapshotLoader.ts'

const largeResponse = () => new Response(' '.repeat(300000))

test('small snapshots decode without a worker and an aborted read never publishes', async () => {
  const snapshot = { workspaceId: 'test', systems: [], files: [], infraNodes: [], dependencies: [] }
  assert.deepEqual(await decodeCanvasSnapshot(new Response(JSON.stringify(snapshot))), snapshot)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(decodeCanvasSnapshot(new Response('{}'), abort.signal), { name: 'AbortError' })
})

test('snapshot batches remain private until completion; cancellation and worker failures terminate the reader', async () => {
  const before = globalThis.Worker, workers = []
  globalThis.Worker = class {
    constructor() { workers.push(this) }
    postMessage(data, transfer) { this.last = data; this.transfer = transfer }
    terminate() { this.terminated = true }
  }
  try {
    let published = false
    const complete = decodeCanvasSnapshot(largeResponse()).then(snapshot => { published = true; return snapshot })
    await new Promise(resolve => setTimeout(resolve, 0))
    const first = workers[0]
    assert.ok(first.last instanceof ArrayBuffer)
    assert.equal(first.transfer[0], first.last)
    first.onmessage({ data: { field: 'files', rows: [{ id: 'first' }] } })
    await Promise.resolve(); assert.equal(published, false)
    assert.deepEqual(first.last, { op: 'next' })
    first.onmessage({ data: { done: true, workspaceId: 'test' } })
    assert.equal((await complete).files[0].id, 'first'); assert.equal(first.terminated, true)

    const abort = new AbortController(), cancelled = decodeCanvasSnapshot(largeResponse(), abort.signal)
    const rejected = assert.rejects(cancelled, { name: 'AbortError' })
    await new Promise(resolve => setTimeout(resolve, 0))
    workers[1].onmessage({ data: { field: 'systems', rows: [{ id: 'partial' }] } })
    abort.abort(); await rejected
    assert.equal(workers[1].terminated, true)

    const failed = decodeCanvasSnapshot(largeResponse()), failure = assert.rejects(failed, /loading failed/)
    await new Promise(resolve => setTimeout(resolve, 0))
    workers[2].onerror({}); await failure
    assert.equal(workers[2].terminated, true)
  } finally { globalThis.Worker = before }
})
