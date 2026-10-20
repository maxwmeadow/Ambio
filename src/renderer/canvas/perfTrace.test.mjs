import assert from 'node:assert/strict'
import test from 'node:test'
import { createPerfTrace, perfTrace, traceSync } from './perfTrace.ts'
test('tracing is opt-in and bounded while retaining full-session totals', () => {
  const trace = createPerfTrace(2, () => 42)
  trace.record('scene.geometry', 100)
  assert.equal(trace.summary().retained, 0)
  trace.start()
  for (const ms of [100, 2, 3]) trace.record('scene.geometry', ms, 1000)
  const summary = trace.summary()
  assert.equal(summary.retained, 2); assert.equal(summary.dropped, 1)
  assert.deepEqual(summary.stages['scene.geometry'], { count: 3, totalMs: 105, maxMs: 100, maxItems: 1000, retainedSamples: 2, retainedP95Ms: 3 })
  trace.stop(); trace.record('scene.geometry', 400)
  assert.equal(trace.summary().stages['scene.geometry'].count, 3)
  trace.start(); assert.deepEqual(trace.summary().stages, {})
})
test('timing preserves results and exceptions and records failed work', () => {
  perfTrace.start()
  assert.equal(traceSync('snapshot.store', () => 7), 7)
  assert.throws(() => traceSync('snapshot.store', () => { throw Error('original') }), /original/)
  assert.equal(perfTrace.summary().stages['snapshot.store'].count, 2)
  perfTrace.stop()
})
