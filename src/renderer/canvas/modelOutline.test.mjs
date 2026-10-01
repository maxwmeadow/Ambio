import assert from 'node:assert/strict'
import test from 'node:test'
import { UNSORTED_ID, buildOutline } from './modelOutline.ts'

const system = (id, name, parentId = null) => ({ id, name, parentId })
const file = (id, relPath, systemId = null) => ({ id, relPath, systemId })
const systems = [system('shop', 'Shop'), system('orders', 'Orders', 'shop'), system('pay', 'Payments')]
const files = [
  file('cart', 'src/orders/cart.ts', 'orders'),
  file('stripe', 'src/payments/stripe.ts', 'pay'),
  file('readme', 'scripts/seed.ts'),
]
const symbols = new Map([['cart', [{ name: 'total', kind: 'function', lineStart: 3 }, { name: 'addItem', kind: 'function', lineStart: 9 }]]])
const rows = (overrides = {}) => buildOutline({ systems, files, symbols, expanded: new Set(), query: '', ...overrides })
const labels = list => list.map(row => `${'  '.repeat(row.depth)}${row.label}`)

test('collapsed, the outline shows top-level systems and the unsorted group', () => {
  assert.deepEqual(labels(rows()), ['Payments', 'Shop', 'Unsorted'])
})

test('expanding walks systems, then files, then symbols', () => {
  const open = rows({ expanded: new Set(['shop', 'orders', 'cart', UNSORTED_ID]) })
  assert.deepEqual(labels(open), ['Payments', 'Shop', '  Orders', '    cart.ts', '      total', '      addItem', 'Unsorted', '  seed.ts'])
  const symbol = open.find(row => row.label === 'total')
  assert.equal(symbol.nodeId, 'cart', 'a symbol selects its file on the canvas')
})

test('searching shows each match with the path to it, opened', () => {
  assert.deepEqual(labels(rows({ query: 'stripe' })), ['Payments', '  stripe.ts'])
  assert.deepEqual(labels(rows({ query: 'addit' })), ['Shop', '  Orders', '    cart.ts', '      addItem'])
  assert.deepEqual(labels(rows({ query: 'nothing matches this' })), [])
})

test('a file whose symbols are not loaded yet can still be opened', () => {
  const stripe = rows({ expanded: new Set(['pay']) }).find(row => row.id === 'stripe')
  assert.equal(stripe.expandable, true)
})

test('a search shows symbols archd found in files not opened yet', () => {
  const found = new Map([['f-pay', [{ name: 'chargeCard', kind: 'function', lineStart: 3 }]]])
  const files = [{ id: 'f-pay', relPath: 'src/pay/stripe.ts', systemId: null }]
  const rows = buildOutline({ systems: [], files, symbols: new Map(), expanded: new Set(), query: 'charge', found })
  assert.deepEqual(rows.map(row => `${row.kind}:${row.label}`), ['unsorted:Unsorted', 'file:stripe.ts', 'symbol:chargeCard'])
  const idle = buildOutline({ systems: [], files, symbols: new Map(), expanded: new Set(), query: '', found })
  assert.deepEqual(idle.map(row => row.kind), ['unsorted'])
})
