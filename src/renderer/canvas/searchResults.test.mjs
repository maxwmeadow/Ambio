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
  assert.equal(symbol.detail, 'class, src/shop/orders/order.ts:4')
})

test('a blank query lists systems outermost first, then infrastructure', () => {
  const results = buildSearchResults({ query: '  ', systems, infraNodes, files, symbols })
  assert.deepEqual(results.map(result => `${result.kind}:${result.title}:${result.detail}`), [
    'system:Shop:Top level',
    'system:Orders:Shop',
    'system:Order History:Shop › Orders',
    'infra:Orders DB:aws, database',
  ])
})

test('search finds sheets, what is drawn on them, notes, conversations and investigations, each named for what it is', async () => {
  const { searchResultBadge } = await import('./searchResults.ts')
  const results = buildSearchResults({
    query: 'checkout', systems: [], infraNodes: [], files: [], symbols: [],
    sheets: [{ id: 'sh1', name: 'Checkout redesign', purpose: '' }, { id: 'sh2', name: 'Payments', purpose: 'How checkout pays' }],
    planned: [{ id: 'p1', sheetId: 'sh2', sheetName: 'Payments', name: 'Checkout Service', kind: 'system' }],
    notes: [
      { id: 'n1', sheetId: null, sheetName: null, body: '# Ideas\nSplit the checkout flow in two.' },
      { id: 'n2', sheetId: 'sh2', sheetName: 'Payments', body: 'Unrelated' },
    ],
    conversations: [{ id: 't1', title: 'Why is the cart slow?', said: ['Why is the cart slow?', 'The checkout query scans every order.'], turns: 2 }],
    investigations: [{ id: 'i1', name: 'checkout run', createdAt: Date.UTC(2026, 10, 11) }],
  })
  assert.deepEqual(results.map(result => [result.kind, result.title]), [
    ['sheet', 'Checkout redesign'], ['sheet', 'Payments'],
    ['planned', 'Checkout Service'],
    ['note', 'Ideas'],
    ['conversation', 'Why is the cart slow?'],
    ['investigation', 'checkout run'],
  ])
  const note = results.find(result => result.kind === 'note')
  assert.match(note.detail, /^On the Floor: .*checkout flow/, 'a match inside a note shows where it is and the words around it')
  assert.match(results.find(result => result.kind === 'conversation').detail, /checkout query/)
  assert.equal(results.find(result => result.kind === 'planned').detail, 'On Payments')
  assert.deepEqual(results.map(searchResultBadge), ['Sheet', 'Sheet', 'Planned system', 'Note', 'Agent', 'Recording'])
})

test('before typing, sheets and recent conversations follow the map', () => {
  const results = buildSearchResults({
    query: '', systems, infraNodes, files, symbols,
    sheets: [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }],
    conversations: [{ id: 't1', title: 'Latest', said: [], turns: 1 }],
  })
  assert.deepEqual(results.slice(-3).map(result => [result.kind, result.title]), [['sheet', 'Alpha'], ['sheet', 'Beta'], ['conversation', 'Latest']])
  assert.equal(results.at(-1).detail, '1 message')
})
