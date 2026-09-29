import assert from 'node:assert/strict'
import test from 'node:test'
import { infraLinks } from './infraLinks.ts'

// Bookings (collapsed) holds bookings.ts and availability.ts; the adapters
// system holds postgres.ts. Files are hidden inside their collapsed systems.
const dep = (src, dst, kind, status = 'confirmed', srcType = 'file') =>
  ({ id: `${src}-${dst}-${kind}`, src, dst, srcType, dstType: 'infra', dependencyType: kind, status })
const base = {
  selectedInfraId: null,
  selectedNodeId: null,
  infraIds: new Set(['pg', 'stripe']),
  fileSystem: new Map([['bookings.ts', 'sys_bookings'], ['availability.ts', 'sys_bookings'], ['postgres.ts', 'sys_adapters']]),
  systemParent: new Map([['sys_bookings', null], ['sys_adapters', null]]),
  visibleNodeId: id => ({ 'bookings.ts': 'sys_bookings', 'availability.ts': 'sys_bookings', 'postgres.ts': 'sys_adapters' })[id] ?? id,
  dependencies: [
    dep('bookings.ts', 'pg', 'WRITES'),
    dep('bookings.ts', 'pg', 'READS'),
    dep('availability.ts', 'pg', 'READS'),
    dep('postgres.ts', 'pg', 'IMPLEMENTS'),
    dep('bookings.ts', 'stripe', 'USES'),
    dep('availability.ts', 'stripe', 'USES', 'dismissed'),
  ],
}

test('selecting a sidebar row shows who touches it, one line per visible box', () => {
  const lines = infraLinks({ ...base, selectedInfraId: 'pg' })
  const bookings = lines.find(line => line.nodeId === 'sys_bookings')
  assert.equal(lines.length, 2)
  assert.ok(lines.every(line => line.infraId === 'pg'))
  assert.equal(bookings.label, 'writes · reads · 2 files', 'specific kinds first, and how many files are behind the line')
  assert.equal(bookings.generic, false)
  const adapters = lines.find(line => line.nodeId === 'sys_adapters')
  assert.equal(adapters.label, 'implements')
  assert.equal(adapters.generic, true, 'only implementation is known: a quieter line')
})

test('selecting a system shows the rows it touches; dismissed relationships are not drawn', () => {
  const lines = infraLinks({ ...base, selectedNodeId: 'sys_bookings' })
  assert.deepEqual(lines.map(line => line.infraId).sort(), ['pg', 'stripe'])
  assert.ok(lines.every(line => line.nodeId === 'sys_bookings'))
  const stripe = lines.find(line => line.infraId === 'stripe')
  assert.equal(stripe.files, 1, 'the dismissed use from availability.ts is not counted')
  assert.equal(stripe.label, 'uses')
})

test('a sidebar selection wins over a canvas selection, and nothing selected draws nothing', () => {
  const lines = infraLinks({ ...base, selectedInfraId: 'stripe', selectedNodeId: 'sys_adapters' })
  assert.deepEqual(lines.map(line => line.nodeId), ['sys_bookings'])
  assert.deepEqual(infraLinks(base), [])
})

test('rows the sidebar does not list draw nothing', () => {
  assert.deepEqual(infraLinks({ ...base, infraIds: new Set(), selectedNodeId: 'sys_bookings' }), [])
})
