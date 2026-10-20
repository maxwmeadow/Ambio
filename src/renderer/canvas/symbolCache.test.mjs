import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchFileSymbols, clearSymbolCache, getCachedSymbols, forgetFileSymbols, setCachedSymbols } from './symbolCache.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('symbol requests share work while consumer cancellation remains independent', async () => {
  const original = globalThis.fetch
  let resolve, calls = 0
  globalThis.fetch = () => { calls++; return new Promise(done => { resolve = done }) }
  try {
    clearSymbolCache()
    const controller = new AbortController()
    const first = fetchFileSymbols('share', 'a', controller.signal, 'http://fixture')
    const second = fetchFileSymbols('share', 'a', undefined, 'http://fixture')
    controller.abort()
    await assert.rejects(first, { name: 'AbortError' })
    resolve(new Response(JSON.stringify([{ name: 'kept' }])))
    assert.equal((await second)[0].name, 'kept')
    assert.equal(calls, 1)
    assert.equal(getCachedSymbols('share', 'a')[0].name, 'kept')
  } finally { clearSymbolCache(); globalThis.fetch = original; await tick() }
})
test('request concurrency is bounded and queued cancellation starts no HTTP work', async () => {
  const original = globalThis.fetch, pending = []
  let active = 0, maximum = 0, calls = 0
  globalThis.fetch = () => { calls++; maximum = Math.max(maximum, ++active); return new Promise(resolve => pending.push(() => { active--; resolve(new Response('[]')) })) }
  try {
    clearSymbolCache()
    const promises = Array.from({ length: 8 }, (_, i) => fetchFileSymbols('limit', String(i), undefined, 'http://fixture'))
    const controller = new AbortController()
    const cancelled = fetchFileSymbols('limit', 'cancel', controller.signal, 'http://fixture')
    controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' })
    assert.equal(calls, 4)
    while (pending.length) { pending.shift()(); await tick() }
    await Promise.all(promises)
    assert.equal(maximum, 4)
    assert.equal(calls, 8)
  } finally { clearSymbolCache(); globalThis.fetch = original; await tick() }
})
test('empty cache answers expire, positive answers are LRU-bounded, and invalidation blocks stale replies', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now
  let now = 100
  Date.now = () => now
  try {
    clearSymbolCache()
    setCachedSymbols('revision', 'empty', [])
    assert.deepEqual(getCachedSymbols('revision', 'empty'), [])
    now += 2001
    assert.equal(getCachedSymbols('revision', 'empty'), null)
    const responses = []
    globalThis.fetch = () => new Promise(resolve => responses.push(resolve))
    const stale = fetchFileSymbols('revision', 'a', undefined, 'http://fixture').catch(e => e)
    forgetFileSymbols('revision', 'a')
    const fresh = fetchFileSymbols('revision', 'a', undefined, 'http://fixture')
    responses[0](new Response('[{"name":"old"}]'))
    responses[1](new Response('[{"name":"new"}]'))
    assert.equal((await stale).name, 'AbortError')
    await fresh
    assert.equal(getCachedSymbols('revision', 'a')[0].name, 'new')
    for (let i = 0; i < 600; i++) setCachedSymbols('bounded', String(i), [{ name: 'x' }])
    assert.equal(getCachedSymbols('bounded', '0'), null)
    assert.ok(getCachedSymbols('bounded', '599'))
  } finally { clearSymbolCache(); Date.now = originalNow; globalThis.fetch = originalFetch; await tick() }
})
