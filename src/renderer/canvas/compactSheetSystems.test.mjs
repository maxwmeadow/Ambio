import assert from 'node:assert/strict'
import test from 'node:test'
import { compactSheetSystems, fitAutomaticSheetContents } from './compactSheetSystems.ts'
import { frameContentInsets } from './frameGeometry.ts'
import { prepareFloorGeometry } from './scene/sceneGeometry.ts'

test('final placement compression reserves real header clearance at every nested level', () => {
  const frame = (id, parentId, depth, x, y, width, height, scale = 1, interiorScale = 1) => ({ id, parentId, depth, nodeType: 'system', worldScale: 1, contentScale: 1, geometry: { x, y, width, height, scale, interiorScale } })
  const descriptors = [
    frame('context', null, 0, 0, 0, 1000, 800, 0.5, 0.5),
    frame('tool', 'context', 1, 30, 80, 476, 269.3),
    frame('inner', 'tool', 2, 12, 25.3, 220, 110),
    frame('cli', 'tool', 2, 244, 25.3, 220, 110),
    frame('fixtures', 'tool', 2, 12, 147.3, 220, 110),
    frame('nested-file', 'inner', 3, 12, 25, 180, 80),
  ]
  const prepared = { descriptors, geometryById: new Map(descriptors.map(d => [d.id, d.geometry])), worldScaleById: new Map(), contentScaleById: new Map() }
  const original = structuredClone(prepared)
  const result = fitAutomaticSheetContents(prepared, new Set(['tool', 'inner']))
  for (const id of ['tool', 'inner']) {
    const parent = result.descriptors.find(d => d.id === id)
    const insets = frameContentInsets(parent.geometry.height, parent.depth, parent.worldScale)
    for (const child of result.descriptors.filter(d => d.parentId === id)) {
      const g = child.geometry, scale = parent.geometry.interiorScale
      assert.ok(g.x * scale >= insets.left - 1e-6)
      assert.ok(g.y * scale >= insets.top - 1e-6)
      assert.ok((g.x + g.width * g.scale) * scale <= parent.geometry.width - insets.right + 1e-6)
      assert.ok((g.y + g.height * g.scale) * scale <= parent.geometry.height - insets.bottom + 1e-6)
      assert.equal(child.worldScale, parent.contentScale * g.scale)
    }
    assert.deepEqual({ width: parent.geometry.width, height: parent.geometry.height }, { width: prepared.geometryById.get(id).width, height: prepared.geometryById.get(id).height })
  }
  assert.deepEqual(result.geometryById.get('context'), prepared.geometryById.get('context'))
  assert.deepEqual(prepared, original)
})

test('a moved single-file system fits its content and leaves the Floor and surrounding frames intact', () => {
  const systems = [{ id: 'parent', workspaceId: 'ws', width: 3000, height: 2000, parentId: null }, { id: 'runtime', workspaceId: 'ws', width: 1600, height: 1000, parentId: 'parent' }]
  const files = [{ id: 'file', systemId: 'runtime', width: 220, height: 110 }]
  const layouts = [{ nodeId: 'parent', parentNodeId: null, positionX: 80, positionY: 90, width: 3000, height: 2000, scale: 1, interiorScale: 1 }, { nodeId: 'file', parentNodeId: 'runtime', positionX: 400, positionY: 300, width: 220, height: 110, scale: 1, interiorScale: 1 }]
  const original = structuredClone({ systems, files, layouts })
  const compact = compactSheetSystems(systems, files, layouts, new Set(['runtime']))
  const runtime = compact.systems.find(node => node.id === 'runtime')
  assert.ok(runtime.width < 400)
  assert.ok(runtime.height < 300)
  const file = compact.layouts.find(node => node.nodeId === 'file')
  assert.ok(file.positionX + file.width <= runtime.width)
  assert.ok(file.positionY + file.height <= runtime.height)
  assert.deepEqual(compact.layouts.find(node => node.nodeId === 'parent'), layouts[0])
  assert.deepEqual({ systems, files, layouts }, original)
})

test('authored systems and their child placements are preserved', () => {
  const systems = [{ id: 'runtime', workspaceId: 'ws', width: 1600, height: 1000, parentId: null }]
  const files = [{ id: 'file', systemId: 'runtime', width: 220, height: 110 }]
  const layouts = [{ nodeId: 'file', parentNodeId: 'runtime', positionX: 80, positionY: 90, width: 220, height: 110, scale: 1, interiorScale: 1 }]
  assert.deepEqual(compactSheetSystems(systems, files, layouts, new Set()), { systems, layouts })
})

test('nested automatic proposals compact from the inside out', () => {
  const systems = [{ id: 'outer', workspaceId: 'ws', width: 1600, height: 1000, parentId: null }, { id: 'inner', workspaceId: 'ws', width: 1600, height: 1000, parentId: 'outer' }]
  const files = [{ id: 'file', systemId: 'inner', width: 220, height: 110 }]
  const result = compactSheetSystems(systems, files, [], new Set(['outer', 'inner']))
  assert.ok(result.systems.every(system => system.width < 700 && system.height < 500))
})

test('scaled sheet interiors clear the rendered tab and keep compacted layout dimensions coherent', () => {
  const systems = [
    { id: 'outer', workspaceId: 'ws', width: 2000, height: 1600, parentId: null },
    { id: 'tool', workspaceId: 'ws', width: 1600, height: 1000, parentId: 'outer' },
  ]
  const files = ['cli', 'tests', 'fixtures'].map(id => ({ id, systemId: 'tool', width: 220, height: 110 }))
  for (const scale of [0.25, 0.5, 1, 2]) {
    const layouts = [
      { nodeId: 'outer', parentNodeId: null, positionX: 80, positionY: 90, width: 2000, height: 1600, scale: 0.5, interiorScale: 0.5 },
      { nodeId: 'tool', parentNodeId: 'outer', positionX: 30, positionY: 80, width: 1600, height: 1000, scale, interiorScale: scale },
    ]
    const original = structuredClone({ systems, files, layouts })
    const result = compactSheetSystems(systems, files, layouts, new Set(['tool']))
    const tool = result.systems.find(node => node.id === 'tool')
    const row = result.layouts.find(node => node.nodeId === 'tool')
    assert.equal(row.width, tool.width, 'canonical layout must use the compacted frame width')
    assert.equal(row.height, tool.height, 'canonical layout must use the compacted frame height')
    const insets = frameContentInsets(tool.height, 1, 0.25 * scale)
    for (const file of files) {
      const child = result.layouts.find(node => node.nodeId === file.id)
      assert.ok(child.positionY * scale >= insets.top - 1e-6, `scale ${scale}: child overlaps the tab`)
      assert.ok(child.positionX * scale >= insets.left - 1e-6)
      assert.ok((child.positionX + child.width * child.scale) * scale <= tool.width - insets.right + 1e-6)
      assert.ok((child.positionY + child.height * child.scale) * scale <= tool.height - insets.bottom + 1e-6)
    }
    assert.deepEqual(result.layouts.find(node => node.nodeId === 'outer'), layouts[0])
    assert.deepEqual({ systems, files, layouts }, original)
  }
})


test('a proposal compressing live context keeps its file and nested contents below their titles', () => {
  const frame = (id, parentId, depth, x, y, width, height, interiorScale = 1) => ({ id, parentId, depth, nodeType: 'system', worldScale: 1, contentScale: 1, geometry: { x, y, width, height, scale: 1, interiorScale } })
  for (const scale of [0.4, 0.5, 0.75]) {
    const descriptors = [
      frame('heuristics', null, 0, 100, 100, 620, 420, scale),
      frame('heuristics.py', 'heuristics', 1, 12, 34.8, 220, 110),
      frame('tool', 'heuristics', 1, 12, 160, 476, 620),
      frame('cli', 'tool', 2, 12, 25.3, 220, 110),
    ]
    const prepared = { descriptors, geometryById: new Map(descriptors.map(d => [d.id, d.geometry])), worldScaleById: new Map(), contentScaleById: new Map(), resizedContainerIds: new Set(['heuristics']) }
    const original = structuredClone(prepared)
    const sourceLayouts = [{ nodeId: 'heuristics', interiorScale: 1 }]
    const result = fitAutomaticSheetContents(prepared, new Set(), sourceLayouts)
    for (const parentId of ['heuristics', 'tool']) {
      const parent = result.descriptors.find(d => d.id === parentId)
      const insets = frameContentInsets(parent.geometry.height, parent.depth, parent.worldScale)
      for (const child of result.descriptors.filter(d => d.parentId === parentId)) {
        const g = child.geometry, interior = parent.geometry.interiorScale
        assert.ok(g.y * interior >= insets.top - 1e-6, `${parentId}: child must clear the tab`)
        assert.ok((g.y + g.height * g.scale) * interior <= parent.geometry.height - insets.bottom + 1e-6)
        assert.ok((g.x + g.width * g.scale) * interior <= parent.geometry.width - insets.right + 1e-6)
        assert.equal(child.worldScale, parent.contentScale * g.scale)
      }
    }
    for (const field of ['x', 'y', 'width', 'height', 'scale']) assert.equal(result.geometryById.get('heuristics')[field], prepared.geometryById.get('heuristics')[field])
    assert.deepEqual(prepared, original, 'Floor/source geometry must not be mutated')
    assert.deepEqual(fitAutomaticSheetContents(prepared, new Set(), [{ nodeId: 'heuristics', interiorScale: scale }]).geometryById.get('heuristics.py'), prepared.geometryById.get('heuristics.py'), 'unchanged authored interiors must not be repacked')
  }
})


test('real incoming placement marks compressed live context for the sheet body fit', () => {
  const systems = [
    { id: 'heuristics', workspaceId: 'ws', parentId: null, width: 620, height: 420 },
    { id: 'neighbor', workspaceId: 'ws', parentId: null, width: 620, height: 420 },
    { id: 'tool', workspaceId: 'ws', parentId: 'heuristics', width: 476, height: 620 },
  ]
  const files = [{ id: 'heuristics.py', systemId: 'heuristics', width: 220, height: 110 }]
  const layouts = [
    { nodeId: 'heuristics', nodeType: 'system', parentNodeId: null, positionX: 100, positionY: 100, width: 620, height: 420, scale: 1, interiorScale: 1 },
    { nodeId: 'neighbor', nodeType: 'system', parentNodeId: null, positionX: 100, positionY: 650, width: 620, height: 420, scale: 1, interiorScale: 1 },
    { nodeId: 'heuristics.py', nodeType: 'file', parentNodeId: 'heuristics', positionX: 12, positionY: 34.8, width: 220, height: 110, scale: 1, interiorScale: 1 },
  ]
  const placed = prepareFloorGeometry(systems, files, [], [], layouts, new Map())
  assert.ok(placed.resizedContainerIds.has('heuristics'))
  assert.ok(placed.geometryById.get('heuristics').interiorScale < 1)
  assert.ok(placed.geometryById.get('heuristics.py').y * placed.geometryById.get('heuristics').interiorScale < frameContentInsets(420, 0).top, 'fixture reproduces clearance lost to origin-based compression')
  const fitted = fitAutomaticSheetContents(placed, new Set(), layouts)
  const parent = fitted.geometryById.get('heuristics'), child = fitted.geometryById.get('heuristics.py')
  assert.ok(child.y * parent.interiorScale >= frameContentInsets(parent.height, 0).top - 1e-6)
  assert.deepEqual(fitted.geometryById.get('neighbor'), placed.geometryById.get('neighbor'))
})
