import assert from 'node:assert/strict'
import test from 'node:test'
import { splitSheetSpec, systemPath } from './splitSystem.ts'

test('a split is drawn as a sheet with the system as context and two parts to name', () => {
  const systems = [{ id: 'shop', name: 'Shop', parentId: null }, { id: 'orders', name: 'Orders', parentId: 'shop' }]
  const path = systemPath('orders', systems)
  assert.equal(path, 'Shop/Orders')
  const spec = splitSheetSpec({ name: 'Orders', path })
  assert.match(spec, /^# Split Orders\n/)
  assert.match(spec, /## Context\n- system `Shop\/Orders`\n/)
  assert.match(spec, /- system `Orders: first part` - /)
  assert.match(spec, /- system `Orders: second part` - /)
})
