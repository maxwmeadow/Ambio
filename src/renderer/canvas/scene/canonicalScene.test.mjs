import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalScene, canonicalSceneSteps, prepareCanonicalSceneSteps, preparedCanonicalScene, materializedIds, canonicalBounds, canonicalInternalNode, canonicalChildStarts, registerCanvasScene, canvasScene, releaseCanvasScene } from './canonicalScene.ts'
import { sceneRecords } from '../renderBudgetGeometry.ts'
import { runSceneSteps } from './sceneSteps.ts'

const node = (id, parentId, x, y) => ({ id, parentId, position: { x, y }, style: { width: 200, height: 100 }, data: {} })

test('cooperative canonical preparation preserves out-of-order, missing-parent and cyclic geometry', async () => {
  const nodes = [node('child', 'parent', 2, 3), node('parent', undefined, 10, 20),
    node('missing', 'absent', 5, 6), node('a', 'b', 7, 8), node('b', 'a', 9, 10),
    ...Array.from({ length: 2000 }, (_, i) => node(String(i), 'parent', i, i))]
  const scene = await runSceneSteps(prepareCanonicalSceneSteps(nodes))
  const expected = canonicalScene(nodes, sceneRecords(nodes))
  assert.deepEqual(scene.records, expected.records)
  assert.deepEqual(scene.rects, expected.rects)
  assert.deepEqual(scene.order, expected.order)
  assert.equal(preparedCanonicalScene(nodes), scene)
  const text = nodes.map(n => ({ ...n, data: { label: 'new metadata' } }))
  const next = await runSceneSteps(prepareCanonicalSceneSteps(text, scene))
  assert.equal(next.records, scene.records)
  assert.equal(next.rects, scene.rects)
  assert.equal(next.order, scene.order)
  assert.equal(next.byId.get('child').data.label, 'new metadata')
  const moved = [{ ...text[0], position: { x: 100, y: 200 } }, ...text.slice(1)]
  const edited = await runSceneSteps(prepareCanonicalSceneSteps(moved, next))
  assert.deepEqual(edited.rects.get('child'), { x: 110, y: 220, width: 200, height: 100 })
  assert.notEqual(edited.records, next.records)
})

test('cancelled canonical preparation never caches partial indexes and checkpoints deep ancestor resolution', async () => {
  const nodes = Array.from({ length: 4000 }, (_, i) => node(String(i), i ? String(i - 1) : undefined, 1, 1)).reverse()
  const steps = canonicalSceneSteps(nodes, sceneRecords(nodes))
  let checkpoints = 0
  for (;;) { const result = steps.next(); if (result.done) break; checkpoints++ }
  assert.ok(checkpoints > 40)
  const abort = new AbortController()
  // Cancel deterministically at a preparation checkpoint, independent of host speed.
  const preparation = prepareCanonicalSceneSteps(nodes)
  function* cancel() { yield preparation.next(); abort.abort(); yield* preparation }
  await assert.rejects(runSceneSteps(cancel(), abort.signal), { name: 'AbortError' })
  assert.equal(preparedCanonicalScene(nodes), undefined)
})
test('different hook facades of one Flow provider share canonical geometry; nested providers remain isolated', () => {
  const scene = canonicalScene([], []), getState = () => ({})
  registerCanvasScene({ getState }, scene)
  assert.equal(canvasScene({ getState }), scene)
  assert.equal(canvasScene({ getState: () => ({}) }), undefined)
  releaseCanvasScene({ getState }, scene)
  assert.equal(canvasScene({ getState }), undefined)
})
test('canonical bounds and nested drop geometry survive eviction, independent of array order', () => {
  const nodes = [node('child', 'parent', 20, 30), node('parent', undefined, 1000, 2000), node('distant', undefined, 1e6, 0)]
  const scene = canonicalScene(nodes, sceneRecords(nodes))
  assert.deepEqual(materializedIds(scene, ['child'], []), ['parent', 'child'])
  assert.deepEqual(canonicalBounds(scene, ['child']), { x: 1020, y: 2030, width: 200, height: 100 })
  assert.deepEqual(canonicalInternalNode(scene, 'child').internals.positionAbsolute, { x: 1020, y: 2030 })
  assert.equal(canonicalBounds(scene).width, 999200)
  assert.equal(canonicalInternalNode(scene, 'deleted'), undefined)
  assert.deepEqual([...canonicalChildStarts(scene, 'parent')], [['child', { x: 20, y: 30 }]])
})
test('camera materialization visits the admitted neighborhood rather than 100k project entities', () => {
  const nodes = Array.from({ length: 100000 }, (_, i) => node(String(i), undefined, i * 1000, 0))
  const records = sceneRecords(nodes), scene = canonicalScene(nodes, records)
  let reads = 0
  const get = scene.byId.get.bind(scene.byId)
  scene.byId.get = id => { reads++; return get(id) }
  assert.deepEqual(materializedIds(scene, ['5', '6'], ['7']), ['5', '6', '7'])
  assert.ok(reads <= 6)
  const selected = nodes.map((n, i) => i === 5 ? { ...n, selected: true } : n)
  const next = canonicalScene(selected, records, scene)
  assert.equal(next.rects, scene.rects)
  assert.equal(next.byId.get('5').selected, true)
  assert.deepEqual(materializedIds(next, ['6'], [], ['5', 'deleted']), ['5', '6'])
})


test('current canonical lookups release the previous scene after collection', async () => {
  // A separate heap makes the collection check deterministic without changing
  // ordinary test-runner flags. Keeping the current lookup alive is essential:
  // the old closure implementation retained its entire previous-scene chain.
  const { spawnSync } = await import('node:child_process')
  const moduleUrl = new URL('./canonicalScene.ts', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { canonicalScene } from ${JSON.stringify(moduleUrl)};
    let current = canonicalScene([{id:'a',position:{x:0,y:0},data:{}}], []);
    const old = new WeakRef(current);
    current = canonicalScene([{id:'a',position:{x:0,y:0},data:{},selected:true}], [], current);
    await setImmediate();
    for(let i=0;i<3;i++){globalThis.gc();await setImmediate();}
    assert.equal(old.deref(),undefined);
    assert.equal(current.byId.get('a').selected,true);
  `
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('prepared presentation indexes do not retain prior scene arrays through their weak cache', async () => {
  const { spawnSync } = await import('node:child_process')
  const moduleUrl = new URL('./canonicalScene.ts', import.meta.url).href
  const visibilityUrl = new URL('../semanticZoom.ts', import.meta.url).href
  const integrityUrl = new URL('../sceneIntegrity.ts', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { prepareCanonicalSceneSteps, rememberPresentationScene, preparedCanonicalScene } from ${JSON.stringify(moduleUrl)};
    import { applyZoomVisibility } from ${JSON.stringify(visibilityUrl)};
    import { prepareFloorSceneIntegritySteps } from ${JSON.stringify(integrityUrl)};
    function prepare(nodes, previous) {
      const steps=prepareCanonicalSceneSteps(nodes, previous);
      for(;;){ const result=steps.next(); if(result.done) return result.value; }
    }
    let nodes=applyZoomVisibility([{id:'a',position:{x:0,y:0},data:{}}], .5);
    function validate(nodes) {
      const steps=prepareFloorSceneIntegritySteps(nodes, 1, new Set(['a']));
      while(!steps.next().done) {}
    }
    validate(nodes);
    let current=prepare(nodes);
    const oldArray=new WeakRef(nodes), oldScene=new WeakRef(current);
    nodes=rememberPresentationScene(nodes,[{...nodes[0],selected:true}]);
    current=preparedCanonicalScene(nodes);
    nodes=[{...nodes[0],data:{label:'echo'}}];
    current=prepare(nodes,current);
    await setImmediate();
    for(let i=0;i<3;i++){globalThis.gc();await setImmediate();}
    assert.equal(oldArray.deref(),undefined);
    assert.equal(oldScene.deref(),undefined);
    assert.equal(current.byId.get('a').selected,true);
    assert.equal(current.byId.get('a').data.label,'echo');
  `
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
