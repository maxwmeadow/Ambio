import assert from 'node:assert/strict'
import test from 'node:test'

// The store keeps each project's open tabs in localStorage; Node has none, so give it one.
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.has(key) ? saved.get(key) : null,
  setItem: (key, value) => { saved.set(key, String(value)) },
  removeItem: key => { saved.delete(key) },
}
const { MAX_SOURCE_TABS, sourceTabId, useSourcePreviewStore } = await import('./sourcePreviewStore.ts')

const store = () => useSourcePreviewStore.getState()
const at = (fileId, lineStart = 1, workspaceId = 'w') => ({ fileId, workspaceId, name: fileId, lineStart })
const id = (fileId, workspaceId = 'w') => sourceTabId({ fileId, workspaceId })
const ids = () => store().tabs.map(tab => tab.request.fileId)

test('closing the editor keeps its files open, and the next file opens beside them', () => {
  store().close()
  store().open(at('a', 3))
  store().hide()
  assert.equal(store().visible, false)
  store().open(at('b'))
  assert.equal(store().visible, true)
  assert.deepEqual(ids(), ['a', 'b'])
  assert.equal(store().active, id('b'))
})

test('opening a file that is already open points its tab at the new lines instead of adding one', () => {
  store().close()
  store().open(at('a', 3))
  store().open(at('b'))
  store().open(at('a', 40))
  assert.deepEqual(ids(), ['a', 'b'])
  assert.equal(store().active, id('a'))
  assert.equal(store().tabs[0].request.lineStart, 40)
  // The same lines again still count as a new open, so the editor shows them again.
  const before = store().tabs[0].openedAt
  store().open(at('a', 40))
  assert.ok(store().tabs[0].openedAt > before)
})

test('closing a tab shows the one used before it; the last one puts the editor away', () => {
  store().close()
  store().open(at('a'))
  store().open(at('b'))
  store().open(at('c'))
  store().activate(id('a'))
  store().requestClose([id('a')])
  assert.equal(store().active, id('c'))
  store().cycle(1)
  assert.equal(store().active, id('b'))
  store().requestClose([id('b'), id('c')])
  assert.deepEqual(store().tabs, [])
  assert.equal(store().active, null)
  assert.equal(store().visible, false)
})

test('tabs with unsaved changes ask before they close, each in turn', () => {
  store().close()
  for (const file of ['a', 'b', 'c', 'd']) store().open(at(file))
  store().setDirty(id('a'), true)
  store().setDirty(id('c'), true)

  store().requestClose([id('c')])
  assert.deepEqual(store().closing, { tabId: id('c'), rest: [] })
  store().cancelClose()
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd'])

  // Close Others from d: b closes at once, a and c ask in turn.
  store().requestClose([id('a'), id('b'), id('c')])
  assert.deepEqual(ids(), ['a', 'c', 'd'])
  assert.deepEqual(store().closing, { tabId: id('a'), rest: [id('c')] })
  assert.equal(store().active, id('a'))
  store().closeTab(id('a'))
  assert.deepEqual(store().closing, { tabId: id('c'), rest: [] })
  store().closeTab(id('c'))
  assert.deepEqual(ids(), ['d'])
  assert.equal(store().closing, null)
})

test('Back returns to the tab a definition was followed from', () => {
  store().close()
  store().open(at('a', 5))
  store().follow(at('b', 9), at('a', 7))
  assert.equal(store().active, id('b'))
  store().back()
  assert.equal(store().active, id('a'))
  assert.equal(store().tabs[0].request.lineStart, 7)
  assert.deepEqual(store().history, [])
})

test('each project keeps its own open files, across restarts', () => {
  store().close()
  store().open(at('a', 1, 'one'))
  store().open(at('b', 1, 'one'))
  store().setPath(id('b', 'one'), 'src/b.ts')
  store().open(at('x', 1, 'two'))
  assert.deepEqual(ids(), ['x'])
  store().open(at('c', 1, 'one'))
  assert.deepEqual(ids(), ['a', 'b', 'c'])
  assert.equal(store().tabs[1].path, 'src/b.ts')
  // What a restart reads back.
  assert.deepEqual(JSON.parse(saved.get('ambio.sourceTabs.one')).tabs.map(tab => tab.request.fileId), ['a', 'b', 'c'])
  store().close()
  assert.equal(saved.has('ambio.sourceTabs.one'), false)
})

test('past the limit the least recently used tab without unsaved changes closes', () => {
  store().close()
  for (let index = 0; index < MAX_SOURCE_TABS; index++) store().open(at(`f${index}`))
  store().setDirty(id('f0'), true)
  store().open(at('new'))
  assert.equal(store().tabs.length, MAX_SOURCE_TABS)
  assert.ok(ids().includes('f0'))
  assert.ok(!ids().includes('f1'))
})
