import assert from 'node:assert/strict'
import test from 'node:test'
import { useGraphStore, handleWsMessage } from './graphStore.ts'

const watch={id:'sensor-watch',fileId:'sensor',symbol:'startSensor',callCount:0}
const doc={id:'saved',name:'Sensor race',createdAt:1000,events:[
  {type:'runtime:watch',payload:{watch}},
  {type:'investigation:hypothesis',payload:{caseId:'original-live-id',hypothesis:{id:'H1',text:'Startup outlives cleanup',status:'open',createdAt:1}}},
  {type:'investigation:run_started',payload:{caseId:'original-live-id',command:'node repro.cjs',hypothesisId:'H1'}},
  {type:'investigation:run',payload:{caseId:'original-live-id',run:{id:'r1',n:1,command:'node repro.cjs',exitCode:0}}},
  {type:'runtime:unwatch',payload:{watch}},
  {type:'investigation:verdict',payload:{caseId:'original-live-id',hypothesis:{id:'H1',text:'Startup outlives cleanup',status:'confirmed',verdict:'Two listeners remain',createdAt:1}}},
  {type:'investigation:conclusion',payload:{caseId:'original-live-id',conclusion:{rootCause:'Late startup',fix:'Cancel startup',at:70}}},
  {type:'investigation:message_delivered',payload:{caseId:'original-live-id',ids:[]}},
].map((event,index)=>({...event,offsetMs:index*100}))}

test('carousel, timeline, map prefix and play/pause share one replay position', () => {
  const before=useGraphStore.getState()
  try {
    useGraphStore.getState().startReplay(doc)
    let state=useGraphStore.getState()
    assert.equal(state.replay.frames.length,6)
    assert.equal(state.replay.cursor,1,'opening selects the first meaningful event')
    assert.equal(state.replay.frameCursor,0)
    assert.equal(state.caseFile.status,'replay')
    assert.equal(state.caseFile.hypotheses[0].status,'open')
    assert.ok(state.runtimeWatches[watch.id])
    state.setReplayPlaying(true)
    assert.equal(useGraphStore.getState().replay.playing,true)
    state.replaySeekFrame(3)
    state=useGraphStore.getState()
    assert.equal(state.replay.playing,false,'manual carousel navigation pauses the shared player')
    assert.equal(state.replay.cursor,5)
    assert.equal(state.replay.frameCursor,3)
    assert.deepEqual(state.runtimeWatches,{},'later map bookkeeping is applied too')
    state.replaySeekFrame(0)
    assert.ok(useGraphStore.getState().runtimeWatches[watch.id],'seeking back rebuilds the earlier map')
    state.replaySeek(6)
    state=useGraphStore.getState()
    assert.equal(state.replay.frameCursor,4)
    state.setReplayPlaying(true)
    state.replayNext()
    state=useGraphStore.getState()
    assert.equal(state.replay.cursor,6,'the fix card shares its conclusion event')
    assert.equal(state.replay.frameCursor,5)
    assert.equal(state.replay.playing,true)
    state.replayNext()
    state=useGraphStore.getState()
    assert.equal(state.replay.cursor,7)
    assert.equal(state.replay.frameCursor,5)
    assert.equal(state.replay.playing,false)
    state.replaySeek(-1)
    state=useGraphStore.getState()
    assert.equal(state.replay.cursor,-1)
    assert.equal(state.replay.frameCursor,-1)
    assert.equal(state.replay.frames.length,6,'restart retains the full saved index')
    assert.deepEqual(state.runtimeWatches,{})
    handleWsMessage({type:'investigation:started',payload:{id:'another-live-case',name:'Live activity'}})
    assert.equal(useGraphStore.getState().caseFile.id,'saved','live start markers cannot replace the replay')
  } finally { useGraphStore.setState(before) }
})

test('empty replay controls do not create a phantom event or play forever', () => {
  const before=useGraphStore.getState()
  try {
    const store=useGraphStore.getState()
    store.startReplay({...doc,id:'empty',events:[]})
    store.replaySeekFrame(10)
    store.replaySeek(10)
    store.setReplayPlaying(true)
    assert.equal(store.replayNext(),false)
    assert.equal(useGraphStore.getState().replay.cursor,-1)
    assert.equal(useGraphStore.getState().replay.playing,false)
  } finally { useGraphStore.setState(before) }
})
