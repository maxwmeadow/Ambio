import assert from 'node:assert/strict'
import test from 'node:test'
import { caseFromState, caseSteps, caseReplayFrames, caseReplayFrameIndex, caseSummary, emptyCase, reduceCase, traceStepsForRun } from './caseFile.ts'

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


test('delayed feedback events from an old investigation cannot enter its replacement', () => {
  const current = emptyCase('new-case', 'Reconnect', 'live')
  const message = { id: 'm1', text: 'Check cleanup', at: 1 }
  assert.equal(reduceCase(current, 'investigation:message', { caseId: 'old-case', message }, 1), current)
  const received = reduceCase(current, 'investigation:message', { caseId: 'new-case', message }, 1)
  assert.equal(received.messages.length, 1)
  assert.equal(reduceCase(received, 'investigation:message_delivered', { caseId: 'old-case', ids: ['m1'] }, 2), received)
  const delivered = reduceCase(received, 'investigation:message_delivered', { caseId: 'new-case', ids: ['m1'] }, 3)
  assert.equal(delivered.messages[0].deliveredAt, 3)
})


test('carousel steps preserve the original question and promote the finding and fix separately', () => {
  let file = fold([
    ['investigation:started', {id:'sensor',name:'Duplicate subscriptions'}],
    ['investigation:hypothesis', hypothesis('H1','Late startup attaches a listener after cleanup.')],
  ])
  const first = caseSteps(file)[0]
  file = reduceCase(file, 'investigation:run_started', {command:'node repro.cjs',hypothesisId:'H1'}, 1200)
  assert.deepEqual(caseSteps(file).map(step=>step.kind), ['hypothesis','running'])
  file = reduceCase(file, 'investigation:run', {run:{id:'r1',n:1,command:'node repro.cjs',exitCode:0,headline:'Two listeners remain'}},1300)
  file = reduceCase(file, 'investigation:verdict',hypothesis('H1',first.text,'confirmed','The interrupted schedule leaves two listeners.'),1400)
  file = reduceCase(file, 'investigation:conclusion',{conclusion:{rootCause:'Startup outlives cleanup.',fix:'Cancel pending startup.',at:1500}},1500)
  const steps = caseSteps(file)
  assert.deepEqual(steps.map(step=>step.kind), ['hypothesis','run','verdict','conclusion','fix'])
  assert.equal(steps[0].id,first.id)
  assert.equal(steps[0].text,first.text,'a verdict must not replace the question card')
  assert.equal(steps[2].status,'confirmed')
  assert.equal(steps[3].text,'Startup outlives cleanup.')
  assert.equal(steps[4].title,'Suggested fix')
  assert.equal(steps[4].text,'Cancel pending startup.')
  assert.equal(steps[1].run.id,'r1')
})

test('carousel IDs survive feedback delivery and legacy snapshot hydration', () => {
  const file = caseFromState({id:'old',name:'Saved case',hypotheses:[{id:'H1',text:'A question',status:'confirmed',createdAt:10,decidedAt:40,verdict:'Supported'}],runs:[{id:'r1',n:1,at:20,command:'node test.cjs'}],messages:[{id:'m1',text:'Check cleanup',at:30}],conclusion:{rootCause:'Late startup',fix:'Cancel startup',at:50}})
  const before = caseSteps(file)
  const delivered = reduceCase(file,'investigation:message_delivered',{ids:['m1']},60)
  assert.deepEqual(caseSteps(delivered).map(step=>step.id),before.map(step=>step.id))
  assert.deepEqual(before.map(step=>step.kind),['hypothesis','run','message','verdict','conclusion','fix'])
})

test('carousel distinguishes failed experiments, an unfinished case and replay before its first event', () => {
  const file = fold([
    ['investigation:started',{id:'c',name:'Missing sensor'}],
    ['investigation:run',{run:{id:'failed',error:'Command not found',n:1}}],
    ['investigation:stopped',{id:'c'}],
  ])
  assert.deepEqual(caseSteps(file).map(step=>step.kind),['run','ended'])
  assert.equal(caseSteps(file)[0].title,'The experiment could not start')
  assert.equal(caseSteps(file)[1].title,'Ended without a conclusion')
  assert.equal(caseSteps(emptyCase('r','Saved case','replay'))[0].kind,'opening')
})


test('the full replay deck maps cards to recorded events without exposing future assessments', () => {
  const events = [
    {type:'runtime:watch',payload:{watch:{id:'w'}}},
    {type:'investigation:hypothesis',payload:{caseId:'live-id',...hypothesis('H1','Startup outlives cleanup.')}},
    {type:'investigation:run_started',payload:{caseId:'live-id',command:'node repro.cjs',hypothesisId:'H1'}},
    {type:'investigation:run',payload:{caseId:'live-id',run:{id:'r1',n:1,command:'node repro.cjs',exitCode:0}}},
    {type:'runtime:unwatch',payload:{watch:{id:'w'}}},
    {type:'investigation:verdict',payload:{caseId:'live-id',...hypothesis('H1','Startup outlives cleanup.','confirmed','Two listeners remain.')}},
    {type:'investigation:conclusion',payload:{caseId:'live-id',conclusion:{rootCause:'Late startup.',fix:'Cancel startup.',at:70}}},
    {type:'investigation:message_delivered',payload:{caseId:'live-id',ids:[]}},
  ].map((event,index)=>({...event,offsetMs:index*100}))
  const frames = caseReplayFrames('saved-id','Sensors',1000,events)
  assert.deepEqual(frames.map(frame=>frame.step.kind),['hypothesis','running','run','verdict','conclusion','fix'])
  assert.deepEqual(frames.map(frame=>frame.eventIndex),[1,2,3,5,6,6])
  assert.equal(frames[0].file.id,'saved-id','live and saved IDs need not match')
  assert.equal(frames[0].file.hypotheses[0].status,'open')
  assert.equal(frames[0].file.conclusion,undefined)
  assert.equal(frames[3].file.hypotheses[0].status,'confirmed')
  assert.equal(caseReplayFrameIndex(frames,-1),-1)
  assert.equal(caseReplayFrameIndex(frames,0),-1)
  assert.equal(caseReplayFrameIndex(frames,4),2,'bookkeeping keeps the previous card')
  assert.equal(caseReplayFrameIndex(frames,6),4,'a seek selects the finding before the fix')
  assert.equal(caseReplayFrameIndex(frames,7),5)
  assert.equal(events[1].payload.caseId,'live-id','projection does not mutate the capture')
})

test('runtime-only and empty captures remain honestly browsable', () => {
  const frames=caseReplayFrames('old','Legacy capture',0,[{type:'runtime:call',offsetMs:10,payload:{symbol:'startSensor',args:'enabled=true'}},{type:'runtime:exception',offsetMs:20,payload:{symbol:'startSensor',message:'Permission denied'}}])
  assert.equal(frames.length,2)
  assert.equal(frames[0].step.title,'Function called')
  assert.equal(frames[1].step.text,'Permission denied')
  assert.deepEqual(frames[0].step.recordedDetails,{symbol:'startSensor',args:'enabled=true'})
  assert.deepEqual(caseReplayFrames('empty','Empty capture',0,[]),[])
})
