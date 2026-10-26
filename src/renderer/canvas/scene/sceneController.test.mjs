import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneController } from './sceneController.ts'
import { prepareFloorGeometry, prepareFloorGeometrySteps, numericGeometryInput } from './sceneGeometry.ts'
import { sameGeometryInput } from './sceneInputs.ts'
import { readFileSync } from 'node:fs'

const input = (count = 1) => ({ systems: [], infraNodes: [], dependencies: [], placements: new Map(),
  files: Array.from({ length: count }, (_, i) => ({ id: String(i), systemId: null, positionX: 1 + i * 300, positionY: 20, width: 220, height: 110 })),
  layouts: Array.from({ length: count }, (_, i) => ({ nodeId: String(i), parentNodeId: null, positionX: 1 + i * 300, positionY: 20, width: 220, height: 110, scale: 1, interiorScale: 1 })) })
const prepare = data => prepareFloorGeometry(data.systems, data.files, data.infraNodes, data.dependencies, data.layouts, data.placements)
test('numeric extraction matches frozen output from the pre-refactor layout', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./sceneGeometry.fixtures.json', import.meta.url), 'utf8'))
  for (const fixture of fixtures.cases) {
    const result = prepareFloorGeometry(fixture.systems, fixture.files, fixture.infra, fixture.dependencies, fixture.layouts, new Map())
    const actual = JSON.parse(JSON.stringify({ descriptors: result.descriptors, generated: [...result.generatedLayoutNodeIds].sort(),
      resized: [...result.resizedContainerIds].sort(), placements: [...result.generatedPlacements] }))
    assert.deepEqual(actual, fixture.expected, fixture.name)
    const numeric = numericGeometryInput(fixture.systems, fixture.files, fixture.infra, fixture.dependencies, fixture.layouts, new Map())
    assert.deepEqual(prepare(numeric), result, `${fixture.name}: transfer projection preserves geometry`)
  }
})
test('source/save echoes reuse numeric preparation; actual geometry and workspace inputs still invalidate it', () => {
  const data = input(3), first = numericGeometryInput(data.systems, data.files, data.infraNodes, data.dependencies, data.layouts, data.placements)
  const echo = numericGeometryInput(data.systems, data.files.map(file => ({ ...file, positionX: 999, width: 900, indexedAt: 100 })), [],
    [{ src: '0', dst: '1' }], [...data.layouts].reverse().map(row => ({ ...row, updatedAt: 200 })), data.placements)
  assert.equal(sameGeometryInput(first, echo), true)
  assert.equal(sameGeometryInput(first, { ...echo, layouts: echo.layouts.map(row => ({ ...row, interiorScale: .8 })) }), false)
  assert.equal(sameGeometryInput(first, { ...echo, layouts: echo.layouts.slice(1) }), false)
  assert.equal(sameGeometryInput(first, { ...echo, placements: new Map([['0', { parentId: null, x: 3, y: 4 }]]) }), false)
})
test('superseded jobs and late worker replies cannot publish over a newer model', async () => {
  const messages = [], port = { postMessage: data => messages.push(data), terminate() {}, onmessage: null, onerror: null }
  const controller = createSceneController(() => port)
  const first = controller.prepare('floor', input())
  const cancelled = assert.rejects(first, { name: 'AbortError' })
  const second = controller.prepare('floor', input(2))
  await cancelled
  let published = false
  second.then(() => { published = true })
  port.onmessage({ data: { op: 'prepared', channel: 'floor', token: messages[0].token, geometry: 'stale' } })
  await Promise.resolve(); assert.equal(published, false)
  const latest = messages.findLast(m => m.op === 'prepare')
  port.onmessage({ data: { op: 'prepared', channel: 'floor', token: latest.token, geometry: 'current' } })
  assert.equal(await second, 'current')
  controller.stop()
})
test('crash rejects pending jobs; restart uses a new token and visibility subscription survives', async () => {
  const ports = [], events = []
  const controller = createSceneController(() => {
    const port = { postMessage(data) { this.last = data }, terminate() {}, onmessage: null, onerror: null }
    ports.push(port); return port
  })
  const stop = controller.subscribe(data => events.push(data), () => events.push('crash'))
  const first = controller.prepare('sheet', input()), failed = assert.rejects(first, /worker stopped/)
  const token = ports[0].last.token
  ports[0].onerror({}); await failed
  controller.restart()
  const second = controller.prepare('sheet', input())
  assert.ok(ports[1].last.token > token)
  ports[1].onmessage({ data: { scene: 2, request: 1 } })
  ports[1].onmessage({ data: { op: 'prepared', channel: 'sheet', token: ports[1].last.token, geometry: 'recovered' } })
  assert.equal(await second, 'recovered')
  assert.deepEqual(events, ['crash', { scene: 2, request: 1 }])
  stop(); controller.stop()
})
test('small worker fallback is asynchronous and preserves geometry; large fallback refuses a UI-thread rebuild', async () => {
  const controller = createSceneController(() => { throw Error('unavailable') })
  const data = input(4)
  let settled = false
  const small = controller.prepare('floor', data).then(value => { settled = true; return value })
  await Promise.resolve(); assert.equal(settled, false)
  assert.deepEqual(await small, prepare(data))
  await assert.rejects(controller.prepare('floor', input(2001)), /Background canvas preparation is unavailable/)
  controller.stop()
})
test('large numeric preparation yields before completion and preserves authored frames', () => {
  const data = input(1000)
  const steps = prepareFloorGeometrySteps(data.systems, data.files, data.infraNodes, data.dependencies, data.layouts, data.placements)
  assert.equal(steps.next().done, false)
  let result
  do { result = steps.next() } while (!result.done)
  const first = result.value.descriptors.find(d => d.id === '0')
  assert.deepEqual(first.geometry, { x: 1, y: 20, width: 220, height: 110, scale: 1, interiorScale: 1 })
})

test('an unresponsive cancelled primitive is terminated instead of starving the newer model indefinitely', async () => {
  let terminated = false
  const controller = createSceneController(() => ({ postMessage() {}, terminate() { terminated = true }, onmessage: null, onerror: null }), { cancelTimeoutMs: 10 })
  const first = controller.prepare('floor', input())
  const cancelled = assert.rejects(first, { name: 'AbortError' })
  const second = controller.prepare('floor', input(2))
  await cancelled
  await assert.rejects(second, /did not yield/)
  assert.equal(terminated, true)
  controller.stop()
})

test('invalid legacy dimensions retain semantic fallbacks during numeric transfer', () => {
  const data = input(1)
  data.files[0].width = 450
  data.layouts[0].width = 0
  const numeric = numericGeometryInput(data.systems, data.files, data.infraNodes, data.dependencies, data.layouts, data.placements)
  assert.deepEqual(prepare(numeric), prepare(data))
})
