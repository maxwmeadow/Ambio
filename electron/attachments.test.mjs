import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { attachmentsDirectory, describePaths, saveAttachment } from './attachments.ts'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-attachments-'))

test('attachments are kept per project under app data, away from ~/.ambio', () => {
  const directory = attachmentsDirectory(path.join('/data', 'Ambio'), 'ws/../other')
  assert.equal(path.basename(path.dirname(directory)), 'attachments')
  assert.equal(path.dirname(directory), path.join('/data', 'Ambio', 'attachments'), 'a project id cannot climb out of the folder')
})

test('pasted text and pasted images are saved as files to attach', () => {
  const directory = scratch()
  const text = saveAttachment(directory, { kind: 'text', text: 'one\ntwo\nthree' })
  assert.equal(text.kind, 'text')
  assert.equal(text.label, 'Pasted text, 3 lines')
  assert.equal(fs.readFileSync(text.path, 'utf8'), 'one\ntwo\nthree')
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
  const image = saveAttachment(directory, { kind: 'image', bytes: png, type: 'image/png' })
  assert.equal(image.kind, 'image')
  assert.match(image.path, /\.png$/)
  assert.match(image.label, /^Pasted image/)
  assert.deepEqual([...fs.readFileSync(image.path)], [...png])
  const named = saveAttachment(directory, { kind: 'image', bytes: png, type: 'image/jpeg', name: 'design draft.jpg' })
  assert.equal(named.label, 'design draft.jpg')
  assert.match(path.basename(named.path), /^design-draft-.*\.jpg$/)
  assert.throws(() => saveAttachment(directory, { kind: 'image', bytes: png, type: 'image/tiff' }), /PNG, JPEG/)
})

test('paths on this computer are described as folders, images or files; missing ones are left out', () => {
  const directory = scratch()
  const folder = path.join(directory, 'docs')
  fs.mkdirSync(folder)
  const file = path.join(directory, 'notes.md')
  const image = path.join(directory, 'Shot.PNG')
  fs.writeFileSync(file, '# notes')
  fs.writeFileSync(image, 'x')
  assert.deepEqual(describePaths([folder, file, image, path.join(directory, 'gone.txt'), '']), [
    { path: folder, kind: 'folder', label: 'docs' },
    { path: file, kind: 'file', label: 'notes.md' },
    { path: image, kind: 'image', label: 'Shot.PNG' },
  ])
})
