import assert from 'node:assert/strict'
import test from 'node:test'
import { scopeSheetScene } from './sheetSceneScope.ts'

const model = {
  systems: [
    { id: 'member', parentId: 'outside' }, { id: 'nested', parentId: 'member' }, { id: 'outside', parentId: null },
    { id: 'planned:group', parentId: 'member' },
  ],
  files: [
    { id: 'nested-file', systemId: 'nested' }, { id: 'outside-file', systemId: 'outside' },
    { id: 'planned:file', systemId: 'planned:group' },
  ],
  infraNodes: [{ id: 'member-infra' }, { id: 'outside-infra' }],
  dependencies: [
    { src: 'nested-file', dst: 'member-infra' }, { src: 'nested-file', dst: 'outside-file' }, { src: 'outside-infra', dst: 'member' },
  ],
  layouts: [{ nodeId: 'outside', parentNodeId: null }],
}

test('the scene includes member systems, their descendants, sheet content and internal dependencies', () => {
  const scoped = scopeSheetScene(model, ['member', 'member-infra', 'planned:group', 'planned:file'], new Map(), [], 'workspace')
  assert.deepEqual(scoped.systems.map(system => system.id), ['member', 'nested', 'planned:group'])
  assert.deepEqual(scoped.files.map(file => file.id), ['nested-file', 'planned:file'])
  assert.deepEqual(scoped.infraNodes.map(infra => infra.id), ['member-infra'])
  assert.deepEqual(scoped.dependencies, [{ src: 'nested-file', dst: 'member-infra' }])
  assert.deepEqual(scoped.layouts, [])
})

test('a blank scope excludes the entire Floor', () => {
  assert.deepEqual(scopeSheetScene(model, [], new Map(), [], 'workspace'), {
    systems: [], files: [], infraNodes: [], dependencies: [], layouts: [],
  })
})

test('an unplaced nested member follows its Floor world geometry when its parent is outside the scope', () => {
  const nodes = [
    { id: 'outside', type: 'system', position: { x: -60, y: 120 }, data: { contentScale: 0.5 } },
    { id: 'outside-file', type: 'file', position: { x: 18, y: 40 }, parentId: 'outside', style: { width: 110, height: 55 }, data: { frameScale: 1, worldScale: 0.5 } },
  ]
  const scoped = scopeSheetScene(model, ['outside-file'], new Map(), nodes, 'workspace')
  assert.deepEqual(scoped.systems, [])
  assert.deepEqual(scoped.layouts, [{
    nodeId: 'outside-file', nodeType: 'file', parentNodeId: null, parentNodeType: null, containmentKind: 'root',
    positionX: -42, positionY: 160, width: 220, height: 110, scale: 0.5, interiorScale: 1, workspaceId: 'workspace', updatedAt: 0,
  }])
})
