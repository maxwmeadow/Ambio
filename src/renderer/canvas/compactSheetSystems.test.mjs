import assert from 'node:assert/strict'
import test from 'node:test'
import { compactSheetSystems } from './compactSheetSystems.ts'

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
