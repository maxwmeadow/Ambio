import assert from 'node:assert/strict'
import test from 'node:test'
import { planStencilPlacement, stencilTargetAt } from './stencilPlacement.ts'
import { frameWorldContentRect } from './nodeGeometry.ts'

const frame = (id, overrides = {}) => ({
  id, type: 'system', position: { x: 100, y: 200 }, selected: false,
  data: { worldScale: 1, contentScale: 1, depth: 0 },
  style: { width: 620, height: 420 }, ...overrides,
})
const fileStencil = { kind: 'file', shape: 'box' }
const plan = (nodes, point, target = nodes[0] ?? null) => planStencilPlacement({
  id: 'planned:new', stencil: fileStencil, point, target, nodes,
  positions: new Map(nodes.map(node => [node.id, node.position])),
  editableIds: new Set(nodes.map(node => node.id)), workspaceId: 'workspace', layouts: [],
  systemIds: new Set(nodes.filter(node => node.type === 'system').map(node => node.id)),
  fileIds: new Set(nodes.filter(node => node.type === 'file').map(node => node.id)), infraIds: new Set(),
})

test('stencils choose the innermost editable frame and ignore another Sheet', () => {
  const outer = frame('live')
  const inner = frame('planned:inner', { parentId: 'live', data: { depth: 1 }, position: { x: 150, y: 250 }, style: { width: 300, height: 200 } })
  const otherSheet = frame('planned:other', { data: { depth: 2 }, position: { x: 160, y: 260 }, style: { width: 100, height: 80 } })
  const nodes = [outer, inner, otherSheet]
  const positions = new Map(nodes.map(node => [node.id, node.position]))
  assert.equal(stencilTargetAt({ x: 180, y: 280 }, nodes, positions, new Set(['live', inner.id]))?.id, inner.id)
  assert.equal(stencilTargetAt({ x: 900, y: 900 }, nodes, positions, new Set(['live', inner.id])), null)
})

test('creation stores parent-local geometry without moving the selected parent', () => {
  const system = frame('planned:system', { selected: true })
  const { layout, plan: result } = plan([system], { x: 150, y: 300 })
  assert.equal(layout.parentNodeId, system.id)
  assert.equal(layout.parentNodeType, 'system')
  assert.equal(layout.positionX, 50)
  assert.equal(layout.positionY, 100)
  assert.deepEqual(result.selectedIds, ['planned:new'])
  assert.deepEqual(result.updates.map(update => update.nodeId), ['planned:new'])
})

test('a new child inherits compressed content scale and avoids existing siblings', () => {
  const system = frame('planned:system', { data: { worldScale: 0.5, contentScale: 0.25, interiorScale: 0.5 }, style: { width: 310, height: 210 } })
  const resident = frame('planned:resident', { type: 'file', parentId: system.id, position: { x: 140, y: 270 }, data: { worldScale: 0.25 }, style: { width: 55, height: 27.5 } })
  const { layout } = plan([system, resident], resident.position, system)
  assert.equal(layout.parentNodeId, system.id)
  assert.equal(layout.width, 220)
  assert.equal(layout.height, 110)
  assert.equal(layout.scale, 1)
  const content = frameWorldContentRect(system, system.position)
  const x = system.position.x + layout.positionX * 0.25
  const y = system.position.y + layout.positionY * 0.25
  assert.ok(x >= content.x && y >= content.y)
  assert.ok(x + 55 <= content.x + content.width && y + 27.5 <= content.y + content.height)
  assert.ok(x + 55 <= resident.position.x || x >= resident.position.x + 55 || y + 27.5 <= resident.position.y || y >= resident.position.y + 27.5)
})

test('dropping on blank canvas creates a root even while a system is selected', () => {
  const system = frame('planned:system', { selected: true })
  const { layout } = plan([system], { x: 1000, y: 900 }, null)
  assert.equal(layout.parentNodeId, null)
  assert.equal(layout.positionX, 1000)
  assert.equal(layout.positionY, 900)
})
