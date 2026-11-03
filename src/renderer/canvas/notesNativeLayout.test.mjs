import assert from 'node:assert/strict'
import test from 'node:test'
import { planCanvasDrop } from './dropPersistence.ts'
import { prepareFloorGeometry } from './scene/sceneGeometry.ts'
import { projectFloorNodes } from './floorSceneProjection.ts'

test('notes use the same occupied-system collision and compression result as other leaf nodes', () => {
  const target = { id: 'system', type: 'system', position: { x: 0, y: 0 }, style: { width: 270, height: 240 }, data: { worldScale: 1, contentScale: 1, depth: 0 } }
  const resident = { id: 'resident', type: 'file', parentId: 'system', position: { x: 20, y: 120 }, style: { width: 220, height: 110 }, data: { worldScale: 1 } }
  const make = type => {
    const id = type === 'note' ? 'note:incoming' : 'incoming'
    const incoming = { id, type, selected: true, position: { x: 300, y: 300 }, style: { width: 220, height: 110 }, data: { worldScale: 1 } }
    return planCanvasDrop({ workspaceId: 'ws', draggedNodeId: id, targetNodeId: target.id, allNodes: [target, resident, incoming],
      absolutePositions: new Map([['system', target.position], ['resident', resident.position], [id, incoming.position]]),
      systemIds: new Set(['system']), fileIds: new Set(['resident', ...(type === 'file' ? [id] : [])]), infraIds: new Set(), floorLayouts: [] })
  }
  const note = make('note'), file = make('file')
  const normalize = plan => plan.updates.map(row => ({ ...row, nodeId: row.nodeId.replace('note:', ''), nodeType: row.nodeType === 'note' ? 'file' : row.nodeType }))
  assert.deepEqual(normalize(note), normalize(file))
  assert.equal(note.updates.find(row => row.nodeId === 'note:incoming').nodeType, 'note')
  assert.equal(note.updates.find(row => row.nodeId === 'note:incoming').parentNodeId, 'system')
})

test('native projection inherits note parent position, scale and system resize minima', () => {
  const systems = [{ id: 'system', name: 'Owner', parentId: null, width: 620, height: 420, positionX: 0, positionY: 0 }]
  const notes = [{ id: 'note:child', systemId: null, width: 260, height: 180, positionX: 0, positionY: 0 }]
  const layouts = [
    { nodeId: 'system', nodeType: 'system', parentNodeId: null, positionX: 100, positionY: 120, width: 620, height: 420, scale: .8, interiorScale: .5 },
    { nodeId: 'note:child', nodeType: 'note', parentNodeId: 'system', positionX: 30, positionY: 100, width: 260, height: 180, scale: 1, interiorScale: 1 },
  ]
  const geometry = prepareFloorGeometry(systems, [], [], [], layouts, new Map(), notes)
  const nodes = projectFloorNodes({ systems, files: [], infraNodes: [], ...geometry, currentZoom: 1 })
  const note = nodes.find(node => node.id === 'note:child')
  assert.equal(note.type, 'note')
  assert.equal(note.parentId, 'system')
  assert.equal(note.data.worldScale, .4)
  assert.equal(note.style.width, 104)
  assert.deepEqual(note.position, { x: 12, y: 40 })
  assert.ok(nodes.find(node => node.id === 'system').data.minResizeHeight >= 100)
})
