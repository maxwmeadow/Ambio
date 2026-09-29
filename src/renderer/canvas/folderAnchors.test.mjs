import assert from 'node:assert/strict'
import test from 'node:test'
import { absoluteRects, bodyRect, folderTabOf, folderTopAnchorX, withFacingHandles } from './folderAnchors.ts'

const system = (id, x, y, width, height, extra = {}) => ({
  id, type: 'system', position: { x, y }, style: { width, height },
  data: { name: 'Pricing Pipeline', depth: 0, directChildCount: 5, presentationScale: 1, ...extra.data },
  ...extra,
})
const file = (id, x, y, parentId) => ({ id, type: 'file', parentId, position: { x, y }, style: { width: 120, height: 60 }, data: {} })

test('a system\'s body starts below its folder tab', () => {
  const node = system('s', 0, 0, 600, 400)
  const tab = folderTabOf(node)
  assert.ok(tab.height > 8 && tab.height < 60, `tab height ${tab.height}`)
  const body = bodyRect({ x: 0, y: 0, width: 600, height: 400 }, tab)
  assert.equal(body.y, tab.height)
  assert.equal(body.height, 400 - tab.height)
})

test('the top anchor sits on the stretch of the body the tab leaves exposed', () => {
  const tab = folderTabOf(system('s', 0, 0, 600, 400))
  const x = folderTopAnchorX(tab, 600)
  assert.ok(x > tab.exposedFrom && x < 600)
})

test('files and deployment boundaries have no tab', () => {
  assert.equal(folderTabOf(file('f', 0, 0)), null)
  assert.equal(folderTabOf(system('d', 0, 0, 300, 200, { data: { umlKind: 'infra' } })), null)
})

test('rects are absolute through nested parents', () => {
  const rects = absoluteRects([system('outer', 100, 50, 800, 600), system('inner', 20, 30, 300, 200, { parentId: 'outer' }), file('f', 5, 7, 'inner')])
  assert.deepEqual(rects.get('f'), { x: 125, y: 87, width: 120, height: 60 })
})

test('edges get the sides that face each other instead of top to top', () => {
  const nodes = [system('left', 0, 0, 300, 200), system('right', 600, 20, 300, 200), system('below', 0, 500, 300, 200)]
  const [across, down] = withFacingHandles([
    { id: 'e1', source: 'left', target: 'right' },
    { id: 'e2', source: 'below', target: 'left' },
  ], nodes)
  assert.equal(across.sourceHandle, 'source-right')
  assert.equal(across.targetHandle, 'target-left')
  assert.equal(down.sourceHandle, 'source-top')
  assert.equal(down.targetHandle, 'target-bottom')
})

test('edges that name their handles, or touch nodes without side handles, are left alone', () => {
  const nodes = [system('a', 0, 0, 300, 200), system('b', 600, 0, 300, 200), { id: 'i', type: 'infra', position: { x: 0, y: 900 }, data: {} }]
  const named = { id: 'n', source: 'a', target: 'b', sourceHandle: 'source-bottom', targetHandle: 'target-bottom' }
  const infra = { id: 'x', source: 'a', target: 'i' }
  const out = withFacingHandles([named, infra], nodes)
  assert.equal(out[0], named)
  assert.equal(out[1], infra)
})
