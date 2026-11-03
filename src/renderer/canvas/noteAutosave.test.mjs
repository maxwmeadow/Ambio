import assert from 'node:assert/strict'
import test from 'node:test'
import { createNoteAutosave } from './noteAutosave.ts'

test('typing during an in-flight note update persists the latest text in revision order', async () => {
  let finish, version = 1
  const writes = []
  const editor = createNoteAutosave({ id: 'note', body: 'Original', revision: 1 }, {
    save: (body, revision) => {
      writes.push({ body, revision })
      return new Promise(resolve => { finish = () => resolve({ id: 'note', body, revision: ++version }) })
    }, remove: async () => {}, draft: () => {},
  }, undefined, 100000)
  editor.begin(); editor.change('First'); const first = editor.flush()
  await Promise.resolve()
  editor.change('Latest'); finish(); await first
  const second = editor.flush(); await Promise.resolve(); finish(); await second
  assert.deepEqual(writes, [{ body: 'First', revision: 1 }, { body: 'Latest', revision: 2 }])
  assert.equal(editor.getSnapshot().dirty, false)
  editor.end()
})

test('a remote update pauses autosave and keeps local text until an explicit choice', async () => {
  const writes = []
  const editor = createNoteAutosave({ id: 'note', body: 'Original', revision: 1 }, {
    save: async (body, revision) => { writes.push({ body, revision }); return { id: 'note', body, revision: revision + 1 } },
    remove: async () => {}, draft: () => {},
  }, undefined, 100000)
  editor.begin(); editor.change('My text')
  editor.receive({ id: 'note', body: 'Agent text', revision: 2 }, false, true)
  await editor.flush()
  assert.deepEqual(writes, [])
  assert.equal(editor.getSnapshot().body, 'My text')
  assert.equal(editor.getSnapshot().conflict, true)
  await editor.keepMine()
  assert.deepEqual(writes, [{ body: 'My text', revision: 2 }])
  editor.end()
})

test('leaving the editor flushes pending text, including an empty note', async () => {
  let saved
  const editor = createNoteAutosave({ id: 'note', body: 'Original', revision: 1 }, {
    save: async (body, revision) => { saved = body; return { id: 'note', body, revision: revision + 1 } },
    remove: async () => {}, draft: () => {},
  }, undefined, 100000)
  editor.begin(); editor.change(''); editor.end(); await editor.flush()
  assert.equal(saved, '')
  assert.equal(editor.getSnapshot().editing, false)
  assert.equal(editor.getSnapshot().dirty, false)
})

test('Delete discards a locally retained draft after remote deletion without recreating it', async () => {
  let retained, calls = 0
  const editor = createNoteAutosave({ id: 'note', body: 'Original', revision: 1 }, {
    save: async () => { calls++; throw Error('must not recreate') },
    remove: async () => { calls++; throw Error('already deleted') }, draft: value => { retained = value },
  }, undefined, 100000)
  editor.begin(); editor.change('My draft')
  editor.receive({ id: 'note', body: 'Original', revision: 1 }, true, true)
  assert.equal(retained.body, 'My draft')
  await editor.remove()
  assert.equal(retained, null)
  assert.equal(calls, 0)
})
