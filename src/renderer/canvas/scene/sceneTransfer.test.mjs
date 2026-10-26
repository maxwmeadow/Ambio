import test from 'node:test'
import assert from 'node:assert/strict'
import { sceneChunks, appendSceneChunk } from './sceneTransfer.ts'
import { runSceneSteps } from './sceneSteps.ts'
import { numericGeometryInput, numericGeometryInputSteps, prepareFloorGeometry } from './sceneGeometry.ts'
import { projectFloorNodes, projectFloorNodeSteps } from '../floorSceneProjection.ts'
import { applyZoomVisibility, zoomVisibilitySteps } from '../semanticZoom.ts'

const data = () => ({ systems: [], infraNodes: [], dependencies: [], placements: new Map(),
  files: Array.from({ length: 3000 }, (_, i) => ({ id: String(i), relPath: `src/${i}.ts`, systemId: null,
    positionX: i * 300 + 1, positionY: 20, width: 220, height: 110 })),
  layouts: Array.from({ length: 3000 }, (_, i) => ({ nodeId: String(i), parentNodeId: null,
    positionX: i * 300 + 1, positionY: 20, width: 220, height: 110, scale: 1, interiorScale: 1 })) })

test('bounded transfer preserves arrays, map keys/order and set membership without an atomic graph clone', () => {
  const source = { rows: Array.from({ length: 2001 }, (_, id) => ({ id })),
    map: new Map([[null, ['root']], ['child', { x: 3 }]]), set: new Set(['a', 'b']) }
  const target = { rows: [], map: new Map(), set: new Set() }
  let chunks = 0
  for (const chunk of sceneChunks(source)) {
    assert.ok(chunk.rows.length <= 512)
    appendSceneChunk(target, structuredClone(chunk)); chunks++
  }
  assert.ok(chunks > 3)
  assert.deepEqual(target, source)
})

test('cooperative extraction, projection and semantic visibility preserve the synchronous geometry contract', async () => {
  const d = data()
  assert.deepEqual(await runSceneSteps(numericGeometryInputSteps(d.systems, d.files, d.infraNodes, d.dependencies, d.layouts, d.placements)),
    numericGeometryInput(d.systems, d.files, d.infraNodes, d.dependencies, d.layouts, d.placements))
  const geometry = prepareFloorGeometry(d.systems, d.files, d.infraNodes, d.dependencies, d.layouts, d.placements)
  const input = { ...d, ...geometry, currentZoom: .5 }
  const synchronous = projectFloorNodes(input)
  const cooperative = await runSceneSteps(projectFloorNodeSteps(input))
  assert.deepEqual(cooperative, synchronous)
  assert.deepEqual(await runSceneSteps(zoomVisibilitySteps(cooperative, .02)), applyZoomVisibility(synchronous, .02))
})

test('superseded preparation yields to cancellation without publishing a partial scene', async () => {
  const abort = new AbortController()
  let completed = false
  function* pending() { for (;;) yield }
  setTimeout(() => abort.abort(), 0)
  await assert.rejects(runSceneSteps(pending(), abort.signal).then(() => { completed = true }), { name: 'AbortError' })
  assert.equal(completed, false)
})
