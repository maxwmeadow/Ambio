import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSearchResults } from './searchResults.ts'

const systems = [
  { id: 'shop', name: 'Shop', parentId: null },
  { id: 'orders', name: 'Orders', parentId: 'shop' },
  { id: 'order-history', name: 'Order History', parentId: 'orders' },
]
const infraNodes = [{ id: 'db', name: 'Orders DB', provider: 'aws', category: 'database' }]
const files = [
  { id: 'f1', relPath: 'src/shop/orders/reorder.ts', systemId: 'orders' },
  { id: 'f2', relPath: 'src/shop/orders/order.ts', systemId: 'orders' },
  { id: 'f3', relPath: 'src/order/index.ts', systemId: null },
]
const symbols = [
  { id: 's1', fileId: 'f2', name: 'Order', kind: 'class', lineStart: 4, lineEnd: 30, relPath: 'src/shop/orders/order.ts' },
  { id: 's2', fileId: 'gone', name: 'OrderLegacy', kind: 'class', lineStart: 1, lineEnd: 2, relPath: 'old.ts' },
]

test('groups systems, infrastructure, files and symbols, ranked within each', () => {
  const results = buildSearchResults({ query: 'order', systems, infraNodes, files, symbols })
  assert.deepEqual(results.map(result => `${result.kind}:${result.title}`), [
    'system:Orders',
    'system:Order History',
    'infra:Orders DB',
    'file:order.ts',
    'file:reorder.ts',
    'file:index.ts',
    'symbol:Order',
  ])
})

test('says where a system sits, and a symbol frames its file', () => {
  const results = buildSearchResults({ query: 'history', systems, infraNodes, files, symbols })
  assert.equal(results[0].detail, 'Shop › Orders')
  const [symbol] = buildSearchResults({ query: 'Order', systems: [], infraNodes: [], files, symbols })
    .filter(result => result.kind === 'symbol')
  assert.equal(symbol.nodeId, 'f2')
  assert.equal(symbol.detail, 'class · src/shop/orders/order.ts:4')
})

test('a blank query finds nothing', () => {
  assert.deepEqual(buildSearchResults({ query: '  ', systems, infraNodes, files, symbols }), [])
})
