import assert from 'node:assert/strict'
import test from 'node:test'
import { arrangeHosting, planHosting } from './hostingPlan.ts'

const systems = [
  { id: 'api', parentId: null }, { id: 'api_routes', parentId: 'api' },
  { id: 'worker', parentId: null }, { id: 'shared', parentId: null },
]
const files = [
  { id: 'f1', relPath: 'api/src/index.ts', systemId: 'api' },
  { id: 'f2', relPath: 'api/src/routes/orders.ts', systemId: 'api_routes' },
  { id: 'f3', relPath: 'worker/tasks.py', systemId: 'worker' },
  { id: 'f4', relPath: 'packages/types/index.ts', systemId: 'shared' },
]
const platforms = [
  { id: 'docker_api', key: 'docker/docker#api', name: 'Docker · api', hosts: [{ dir: 'api' }] },
  { id: 'docker_worker', key: 'docker/docker#worker', name: 'Docker · worker', hosts: [{ dir: 'worker' }] },
  { id: 'fly', key: 'fly/platform', name: 'Fly.io', hosts: [{ dir: 'api', via: 'docker/docker#api' }] },
]

test('code sits in its container and the container sits on its platform', () => {
  const { parentOf } = planHosting({ platforms, systems, files, runsOn: [] })
  assert.equal(parentOf.get('api'), 'docker_api', 'the api system (and its nested routes) is in the api image')
  assert.equal(parentOf.get('docker_api'), 'fly', 'Fly runs the api image')
  assert.equal(parentOf.get('worker'), 'docker_worker')
  assert.equal(parentOf.has('shared'), false, 'code no host runs stays outside every frame')
  assert.equal(parentOf.has('api_routes'), false, 'only top-level systems are hosted; nested ones come along')
})

test('a file named as running on a platform beats a folder', () => {
  const { parentOf } = planHosting({
    platforms: [{ id: 'vercel', key: 'vercel/platform', name: 'Vercel', hosts: [{ dir: '.' }] }, platforms[0]],
    systems, files, runsOn: [{ src: 'f3', srcType: 'file', dst: 'vercel' }],
  })
  assert.equal(parentOf.get('worker'), 'vercel')
  assert.equal(parentOf.get('api'), 'docker_api', 'a narrower folder beats the whole app')
  assert.equal(parentOf.has('shared'), false, 'Vercel names what it runs, so its root config claims nothing more')
  const whole = planHosting({
    platforms: [{ id: 'railway', key: 'railway/platform', name: 'Railway', hosts: [{ dir: '.' }] }],
    systems, files, runsOn: [],
  })
  assert.equal(whole.parentOf.get('shared'), 'railway', 'a root config with nothing narrower runs the whole app')
})

test('frames open around their contents, inside out, and move aside rather than cover the map', () => {
  const plan = planHosting({ platforms, systems, files, runsOn: [] })
  const current = new Map([
    ['api', { id: 'api', nodeType: 'system', worldX: 1000, worldY: 400, width: 600, height: 400, scale: 1, interiorScale: 1 }],
  ])
  const rows = arrangeHosting('fly', plan, current, [])
  const byId = new Map(rows.map(row => [row.nodeId, row]))
  assert.equal(byId.get('api').parentNodeId, 'docker_api')
  assert.equal(byId.get('docker_api').parentNodeId, 'fly')
  assert.equal(byId.get('fly').parentNodeId, null)
  assert.ok(byId.get('docker_api').width > 600, 'the container is sized to hold the system')
  assert.ok(byId.get('fly').width > byId.get('docker_api').width, 'the platform is sized to hold the container')
  assert.ok(Math.abs(byId.get('fly').positionX - 1000) < 80, 'the frame opens where the code already was')

  const blocked = arrangeHosting('fly', plan, current, [{ x: 900, y: 300, width: 900, height: 700 }])
  const fly = blocked.find(row => row.nodeId === 'fly')
  const overlapsBlock = fly.positionX < 1800 && fly.positionX + fly.width > 900 && fly.positionY < 1000 && fly.positionY + fly.height > 300
  assert.equal(overlapsBlock, false)
})
