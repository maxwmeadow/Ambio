import assert from 'node:assert/strict'
import test from 'node:test'
import { caseFromState, caseSummary, emptyCase, reduceCase, traceStepsForRun } from './caseFile.ts'

const fold = (events, start = null) =>
  events.reduce((state, [type, payload], i) => reduceCase(state, type, payload, 1000 + i * 100), start)

const hypothesis = (id, text, status = 'open', verdict) => ({ hypothesis: { id, text, status, verdict, createdAt: 1 } })

test('a live case builds up in the order the agent worked', () => {
  const c = fold([
    ['investigation:started', { id: 'c1', name: 'Loyalty doubled', origin: 'agent' }],
    ['investigation:hypothesis', hypothesis('H1', 'awardPoints is subscribed twice')],
    ['investigation:run_started', { command: 'npm run simulate', watches: [{ symbol: 'awardPoints' }] }],
    ['investigation:run', { run: { id: 'r1', n: 1, command: 'npm run simulate', exitCode: 0, headline: 'ran twice', findings: [{ kind: 'repeat', severity: 'high', text: '`awardPoints` ran twice' }] } }],
    ['investigation:verdict', hypothesis('H1', 'awardPoints is subscribed twice', 'confirmed', 'ran 96 times')],
    ['investigation:note', { text: 'registerNotifications() re-registers loyalty', anchors: [{ fileId: 'f1', symbol: 'registerNotifications' }] }],
    ['investigation:conclusion', { conclusion: { rootCause: 'registerLoyalty runs twice', at: 5 } }],
  ])
  assert.equal(c.status, 'live')
  assert.deepEqual(c.entries.map(e => e.kind), ['hypothesis', 'run', 'verdict', 'note', 'conclusion'])
  assert.equal(c.hypotheses[0].status, 'confirmed', 'the verdict updates the hypothesis in place')
  assert.equal(c.hypotheses.length, 1)
  assert.equal(c.running, null, 'a finished run clears the running state')
  assert.equal(c.runs[0].findings[0].severity, 'high')
  assert.equal(caseSummary(c), 'registerLoyalty runs twice')
})

test('the summary says what is established before there is a conclusion', () => {
  const testing = fold([
    ['investigation:started', { id: 'c', name: 'x' }],
    ['investigation:hypothesis', hypothesis('H1', 'cache key ignores region')],
  ])
  assert.equal(caseSummary(testing), 'Testing: cache key ignores region')
  const withRun = reduceCase(testing, 'investigation:run', { run: { id: 'r', n: 1, findings: [{ severity: 'high', text: '`get` returned `undefined` on 3 of 9 calls' }] } }, 9)
  assert.equal(caseSummary(withRun), 'get returned undefined on 3 of 9 calls', 'code marks are for display, not the summary')
})

test('a message is shown once and marked delivered when the agent receives it', () => {
  const msg = { message: { id: 'm1', text: 'look at tax', at: 3 } }
  const c = fold([
    ['investigation:started', { id: 'c', name: 'x' }],
    ['investigation:message', msg],
    ['investigation:message', msg],
    ['investigation:message_delivered', { ids: ['m1'] }],
  ])
  assert.equal(c.messages.length, 1, 'a re-broadcast message is not duplicated')
  assert.equal(c.entries.filter(e => e.kind === 'message').length, 1)
  assert.ok(c.messages[0].deliveredAt)
})

test('stopping a live case keeps it on screen, closed, with a capture to replay', () => {
  const c = fold([
    ['investigation:started', { id: 'c9', name: 'x' }],
    ['investigation:run_started', { command: 'npm test' }],
    ['investigation:stopped', { id: 'c9' }],
  ])
  assert.equal(c.status, 'closed')
  assert.equal(c.savedId, 'c9')
  assert.equal(c.running, null, 'a stopped case is not still running')
})

test('a replayed case is never closed by a live stop broadcast', () => {
  const replaying = emptyCase('old', 'Earlier case', 'replay')
  assert.equal(reduceCase(replaying, 'investigation:stopped', { id: 'other' }, 1), replaying)
})

test('events without a case, or unrelated events, leave state untouched', () => {
  assert.equal(reduceCase(null, 'investigation:note', { text: 'x' }, 1), null)
  const c = emptyCase('c', 'x', 'live')
  assert.equal(reduceCase(c, 'graph:patch', {}, 1), c)
  assert.equal(reduceCase(c, 'investigation:note', {}, 1), c, 'an empty note is not an entry')
})

test('a window opening mid-investigation rebuilds the story in time order', () => {
  const c = caseFromState({
    id: 'c', name: 'Shipping', origin: 'agent', startedAt: 0,
    hypotheses: [{ id: 'H1', text: 'shared table', status: 'confirmed', createdAt: 10, decidedAt: 40 }],
    runs: [{ id: 'r1', n: 1, command: 'npm run simulate', exitCode: 0, headline: 'mutates', findings: [], at: 30 }],
    notes: [{ text: 'found it', at: 20 }],
    messages: [{ id: 'm', text: 'hi', at: 50, deliveredAt: 55 }],
    conclusion: { rootCause: 'shared table', at: 60 },
  })
  assert.deepEqual(c.entries.map(e => e.kind), ['hypothesis', 'note', 'run', 'verdict', 'message', 'conclusion'])
  assert.equal(caseFromState(null), null)
})

test('with nothing in focus, a run draws its busiest crossings', () => {
  const steps = traceStepsForRun({
    calls: [
      { fromFileId: 'a', fromSymbol: 'checkout', toFileId: 'b', toSymbol: 'quote', calls: 48 },
      { fromFileId: 'a', fromSymbol: 'checkout', toFileId: 'c', toSymbol: 'log', calls: 900 },
    ],
  }, 1)
  assert.deepEqual(steps, [{ callerFile: 'a', callerSymbol: 'checkout', calleeFile: 'c', calleeSymbol: 'log', callCount: 900 }])
})

// The shape of the ledgerly run: plumbing dominates the counts, and the
// watched function sits two callers below the entry point.
const call = (from, fromSymbol, to, toSymbol, calls) => ({ fromFileId: from, fromSymbol, toFileId: to, toSymbol, calls })
const ledgerly = {
  calls: [
    call('pipeline', 'runPipeline', 'registry', 'ruleById', 410),
    call('issue', 'issueInvoice', 'money', 'roundCents', 328),
    call('price', 'priceUsage', 'rating', 'rateLine', 292),
    call('price', 'priceUsage', 'terms', 'effectivePricing', 82),
    call('issue', 'issueInvoice', 'price', 'priceUsage', 82),
    call('batch', 'main', 'issue', 'issueInvoice', 1),
    call('terms', 'effectivePricing', 'config', 'pricingConfig', 82),
  ],
  watched: [{ anchor: { fileId: 'terms', symbol: 'effectivePricing' }, calls: 82, errors: 0 }],
  findings: [],
}

test('a run draws how execution reached the watched function, not the busiest calls', () => {
  const steps = traceStepsForRun(ledgerly)
  const drawn = steps.map(s => `${s.callerSymbol}>${s.calleeSymbol}`)
  assert.deepEqual(drawn, [
    'priceUsage>effectivePricing',
    'issueInvoice>priceUsage',
    'main>issueInvoice',
    'effectivePricing>pricingConfig',
  ])
  assert.deepEqual(steps.filter(s => s.focus).map(s => s.calleeSymbol), ['effectivePricing'])
})

test('a finding puts its function in focus even when nothing was watched', () => {
  const steps = traceStepsForRun({
    ...ledgerly,
    watched: [],
    findings: [{ kind: 'drift', severity: 'high', text: 'x', anchor: { fileId: 'rating', symbol: 'rateLine' } }],
  })
  assert.deepEqual(steps.map(s => s.calleeSymbol), ['rateLine', 'priceUsage', 'issueInvoice'])
})

test('a focus the recorded calls never reach falls back to the busiest crossings', () => {
  const steps = traceStepsForRun({ ...ledgerly, watched: [{ anchor: { fileId: 'x', symbol: 'nowhere' }, calls: 0, errors: 0 }] }, 2)
  assert.deepEqual(steps.map(s => s.calleeSymbol), ['ruleById', 'roundCents'])
})
