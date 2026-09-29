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
