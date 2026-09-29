import assert from 'node:assert/strict'
import test from 'node:test'
import { calloutText, mergeTraceLines, placeCallout, runCallouts } from './runTraceProjection.ts'

const step = (callerFile, callerSymbol, calleeFile, calleeSymbol, callCount, focus) =>
  ({ callerFile, callerSymbol, calleeFile, calleeSymbol, callCount, ...(focus ? { focus } : {}) })

// Files a, b sit in collapsed system S; c, d in collapsed system T.
const collapsed = id => ({ a: 'S', b: 'S', c: 'T', d: 'T' })[id] ?? null

test('calls between two collapsed systems draw one line, not one per call', () => {
  const lines = mergeTraceLines([
    step('a', 'priceUsage', 'c', 'effectivePricing', 82, true),
    step('b', 'runPipeline', 'd', 'contractCredits', 82),
    step('a', 'priceUsage', 'd', 'activeContracts', 82),
  ], collapsed)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].key, 'S>T')
  assert.equal(lines[0].calls, 246)
  assert.equal(lines[0].pairs.length, 3, 'every merged call is still named on hover')
  assert.equal(lines[0].label, 'effectivePricing ×82', 'the label names the function the run is about')
})

test('a call inside one box is not a line', () => {
  assert.deepEqual(mergeTraceLines([step('a', 'x', 'b', 'y', 3)], collapsed), [])
})

test('connective lines carry no label', () => {
  const [line] = mergeTraceLines([step('a', 'issueInvoice', 'c', 'priceUsage', 82)], collapsed)
  assert.equal(line.label, null)
  assert.equal(line.focus, false)
})

test('a line into several focus functions names the busiest and counts the rest', () => {
  const [line] = mergeTraceLines([
    step('a', 'p', 'c', 'findCustomer', 60, true),
    step('a', 'p', 'd', 'effectivePricing', 82, true),
  ], collapsed)
  assert.equal(line.label, 'effectivePricing +1 ×82')
})

test('an unresolvable end drops the line', () => {
  assert.deepEqual(mergeTraceLines([step('a', 'x', 'zzz', 'y', 1)], collapsed), [])
})

test('a callout carries the most severe finding on its function, as a headline', () => {
  const [callout] = runCallouts({
    watched: [{ anchor: { fileId: 'terms', symbol: 'effectivePricing' }, calls: 82, errors: 0 }],
    findings: [
      { kind: 'repeat', severity: 'medium', text: '`effectivePricing` receives the same object', anchor: { fileId: 'terms', symbol: 'effectivePricing' } },
      {
        kind: 'mutation', severity: 'high',
        text: '`effectivePricing` changes its argument `customer.pricing.tier` on 6 of 82 calls: "growth" → "partner" - and it receives the same object',
        anchor: { fileId: 'terms', symbol: 'effectivePricing' },
      },
    ],
  })
  assert.equal(callout.tone, 'alert')
  assert.equal(callout.text, 'changes its argument customer.pricing.tier on 6 of 82 calls')
  assert.equal(callout.calls, 82)
})

test('a watched function the run said nothing about still gets a plain callout', () => {
  const [callout] = runCallouts({ watched: [{ anchor: { fileId: 'f', symbol: 'g' }, calls: 3, errors: 0 }], findings: [] })
  assert.equal(callout.tone, 'plain')
  assert.equal(callout.text, null)
  assert.deepEqual(runCallouts(null), [])
})

test('callout text keeps short findings whole', () => {
  assert.equal(calloutText('`ship` threw `ValueError: cannot ship 9` on 1 of 2 calls', 'ship'), 'threw ValueError: cannot ship 9 on 1 of 2 calls')
})

test('a callout moves off a neighbour rather than covering it', () => {
  const anchor = { x: 0, y: 100, width: 200, height: 100 }
  const size = { width: 150, height: 40 }
  const free = placeCallout(anchor, size, [], [], 10)
  assert.deepEqual(free, { x: 50, y: 50, width: 150, height: 40 }, 'above, right-aligned by default')
  const neighbour = { x: 0, y: 0, width: 400, height: 90 }
  const moved = placeCallout(anchor, size, [neighbour], [], 10)
  assert.deepEqual(moved, { x: 210, y: 100, width: 150, height: 40 }, 'beside the box when something sits above it')
  const second = placeCallout(anchor, size, [], [free], 10)
  assert.notDeepEqual(second, free, 'two callouts never stack on one spot')
})
