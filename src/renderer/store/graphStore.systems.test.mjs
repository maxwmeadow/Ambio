import assert from 'node:assert/strict'
import test from 'node:test'
import { useGraphStore } from './graphStore.ts'

const authored = { id: 'sys-tax', name: 'Tax', source: 'agent', workspaceId: 'ws' }
const inferred = { id: 'cluster_refund', name: 'Refund', source: 'cluster', workspaceId: 'ws' }

test('a live session shows the same systems a reload would', () => {
  useGraphStore.getState().applySnapshot({ workspaceId: 'ws', systems: [authored, inferred], files: [], infraNodes: [], dependencies: [], floorLayouts: [] })
  const afterReload = useGraphStore.getState().systems.map(system => system.id)
  assert.deepEqual(afterReload, ['sys-tax'], 'the snapshot withholds inferred groupings')

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    useGraphStore.getState().applyDbPatch({ type: 'system:upserted', payload: { ...inferred, id: 'cluster_new' } })
    assert.deepEqual(useGraphStore.getState().systems.map(system => system.id), afterReload,
      'a live inferred system is withheld too, rather than appearing now and vanishing at the next launch')
    assert.equal(useGraphStore.getState().nodeFx.cluster_new, undefined, 'and gets no arrival animation')

    useGraphStore.getState().applyDbPatch({ type: 'system:upserted', payload: { ...authored, id: 'sys-new', name: 'Refunds' } })
    assert.ok(useGraphStore.getState().systems.some(system => system.id === 'sys-new'), 'an authored system still arrives live')
    assert.equal(useGraphStore.getState().nodeFx['sys-new'].kind, 'enter')

    useGraphStore.getState().applyDbPatch({ type: 'system:upserted', payload: { ...authored, source: 'cluster' } })
    assert.equal(useGraphStore.getState().systems.some(system => system.id === 'sys-tax'), false,
      'a system that becomes inferred leaves the canvas, as it would on reload')
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

function withTimersOff(fn) {
  const original = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try { return fn() } finally { globalThis.setTimeout = original }
}

test('files an agent builds wait in Unsorted, even when the clusterer guessed a system', () => {
  useGraphStore.getState().applySnapshot({ workspaceId: 'ws', systems: [authored, inferred], files: [], infraNodes: [], dependencies: [], floorLayouts: [] })
  withTimersOff(() => {
    const before = useGraphStore.getState().unsortedArrivalKey
    const patch = file => useGraphStore.getState().applyDbPatch({ type: 'file:updated', payload: file })
    patch({ id: 'new-a', relPath: 'src/refunds/refund.ts', systemId: null })
    patch({ id: 'new-b', relPath: 'src/refunds/policy.ts', systemId: 'cluster_refund' })
    const state = useGraphStore.getState()
    assert.equal(state.unsortedArrivalKey, before + 2, 'both went to the bin')
    assert.equal(state.nodeFx['new-a'], undefined, 'no arrival plays on the canvas')
    assert.equal(state.nodeFx['new-b'], undefined, 'a guessed system is not a place on the canvas')
  })
})

test('assignment is when a new file arrives on the canvas', () => {
  useGraphStore.getState().applySnapshot({
    workspaceId: 'ws', systems: [authored, { ...authored, id: 'sys-other', name: 'Other' }],
    files: [{ id: 'waiting', systemId: null }, { id: 'placed', systemId: 'sys-tax' }],
    infraNodes: [], dependencies: [], floorLayouts: [],
  })
  withTimersOff(() => {
    const assign = (fileId, systemId) => useGraphStore.getState().applyDbPatch({ type: 'file:assigned', payload: { fileId, systemId } })
    assign('waiting', 'sys-tax')
    assert.equal(useGraphStore.getState().nodeFx.waiting.kind, 'enter', 'leaving the bin plays the arrival')
    assign('placed', 'sys-other')
    assert.equal(useGraphStore.getState().nodeFx.placed.kind, 'classify', 'moving between systems is a quieter re-file')
    assign('placed', 'cluster_hidden')
    assert.equal(useGraphStore.getState().files.find(f => f.id === 'placed').systemId, 'cluster_hidden')
  })
})
