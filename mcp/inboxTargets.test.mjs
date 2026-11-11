import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { attachmentTarget } from './inboxTargets.ts'
import { attachmentReference } from '../src/shared/attachments.ts'

test('get_inbox gives an attachment by its path, and pasted text in full', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-inbox-targets-'))
  const pasted = path.join(directory, 'pasted.txt')
  fs.writeFileSync(pasted, 'Stack trace:\n  at main()')
  const image = path.join(directory, 'shot.png')
  fs.writeFileSync(image, 'x')

  const text = attachmentTarget(attachmentReference({ path: pasted, kind: 'text', label: 'Pasted text, 2 lines' }))
  assert.equal(text.type, 'path')
  assert.equal(text.kind, 'text')
  assert.equal(text.path, pasted)
  assert.equal(text.text, 'Stack trace:\n  at main()')

  const shot = attachmentTarget(attachmentReference({ path: image, kind: 'image', label: 'shot.png' }))
  assert.deepEqual([shot.kind, shot.path, shot.label, shot.text, shot.missing], ['image', image, 'shot.png', undefined, undefined])

  const gone = attachmentTarget(attachmentReference({ path: path.join(directory, 'gone.txt'), kind: 'text', label: 'Pasted text' }))
  assert.equal(gone.missing, true)
  assert.equal(attachmentTarget('ambio://file/f1?label=a.ts'), null, 'map references keep their own shape')
})
