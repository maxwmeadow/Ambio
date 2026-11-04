import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_SOURCE_TABS, sourceTabId, useSourcePreviewStore } from './sourcePreviewStore.ts'

const store = () => useSourcePreviewStore.getState()
const at = (fileId, lineStart = 1) => ({ fileId, workspaceId: 'w', name: fileId, lineStart })
const ids = () => store().tabs.map(tab => tab.request.fileId)

test('opening a file that is already open points its tab at the new lines instead of adding one', () => {
  store().close()
  store().open(at('a', 3))
  store().open(at('b'))
  store().open(at('a', 40))
  assert.deepEqual(ids(), ['a', 'b'])
  assert.equal(store().active, sourceTabId(at('a')))
  assert.equal(store().tabs[0].request.lineStart, 40)
  assert.equal(store().visible, true)
  // The same lines again still count as a new open, so the editor shows them again.
  const before = store().tabs[0].openedAt
  store().open(at('a', 40))
  assert.ok(store().tabs[0].openedAt > before)
})

test('closing a tab shows the one used before it; the last one closes the editor', () => {
  store().close()
  store().open(at('a'))
  store().open(at('b'))
  store().open(at('c'))
  store().activate(sourceTabId(at('a')))
  store().requestCloseTab(sourceTabId(at('a')))
  assert.equal(store().active, sourceTabId(at('c')))
  store().cycle(1)
  assert.equal(store().active, sourceTabId(at('b')))
  store().requestCloseTab(sourceTabId(at('b')))
  store().requestCloseTab(sourceTabId(at('c')))
  assert.deepEqual(store().tabs, [])
  assert.equal(store().active, null)
})

test('a tab with unsaved changes asks before it closes, and closing all asks in each in turn', () => {
  store().close()
  store().open(at('a'))
  store().open(at('b'))
  store().open(at('c'))
  store().setDirty(sourceTabId(at('a')), true)
  store().setDirty(sourceTabId(at('c')), true)

  store().requestCloseTab(sourceTabId(at('c')))
  assert.deepEqual(store().closing, { tabId: sourceTabId(at('c')), all: false })
  store().cancelClose()
  assert.deepEqual(ids(), ['a', 'b', 'c'])

  store().requestCloseAll()
  assert.deepEqual(store().closing, { tabId: sourceTabId(at('a')), all: true })
  assert.equal(store().active, sourceTabId(at('a')))
  store().closeTab(sourceTabId(at('a')))
  assert.deepEqual(store().closing, { tabId: sourceTabId(at('c')), all: true })
  store().closeTab(sourceTabId(at('c')))
  assert.deepEqual(store().tabs, [])
})

test('Back returns to the tab a definition was followed from; stepping aside keeps the tabs', () => {
  store().close()
  store().open(at('a', 5))
  store().follow(at('b', 9), at('a', 7))
  assert.equal(store().active, sourceTabId(at('b')))
  store().back()
  assert.equal(store().active, sourceTabId(at('a')))
  assert.equal(store().tabs[0].request.lineStart, 7)
  assert.deepEqual(store().history, [])
  store().hide()
  assert.equal(store().visible, false)
  assert.deepEqual(ids(), ['a', 'b'])
  store().open(at('c'))
  assert.equal(store().visible, true)
  assert.deepEqual(ids(), ['a', 'b', 'c'])
})

test('past the limit the least recently used tab without unsaved changes closes', () => {
  store().close()
  for (let index = 0; index < MAX_SOURCE_TABS; index++) store().open(at(`f${index}`))
  store().setDirty(sourceTabId(at('f0')), true)
  store().open(at('new'))
  assert.equal(store().tabs.length, MAX_SOURCE_TABS)
  assert.ok(ids().includes('f0'))
  assert.ok(!ids().includes('f1'))
})
