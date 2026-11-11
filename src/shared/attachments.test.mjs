import assert from 'node:assert/strict'
import test from 'node:test'
import { attachesPaste, attachmentOf, attachmentReference, isImagePath, pastedTextLabel } from './attachments.ts'

test('an attachment travels as a reference and comes back the same, Windows paths included', () => {
  for (const attachment of [
    { path: 'C:\\Users\\me\\Pictures\\shot one.png', kind: 'image', label: 'shot one.png' },
    { path: '/home/me/notes?#.txt', kind: 'text', label: 'Pasted text, 40 lines' },
    { path: '/home/me/project', kind: 'folder', label: 'project' },
  ]) {
    const reference = attachmentReference(attachment)
    assert.match(reference, /^ambio:\/\/path\//)
    assert.deepEqual(attachmentOf(reference), attachment)
  }
  assert.equal(attachmentOf('ambio://file/f1?label=a.ts'), null, 'a map reference is not an attachment')
  assert.equal(attachmentOf('ambio://path/?kind=file'), null)
  assert.deepEqual(attachmentOf('ambio://path/%2Ftmp%2Fa.bin'), { path: '/tmp/a.bin', kind: 'file', label: 'a.bin' })
})

test('long pastes attach; a sentence or a short snippet stays in the box', () => {
  assert.equal(attachesPaste('Fix the login bug please.'), false)
  assert.equal(attachesPaste(Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n')), false)
  assert.equal(attachesPaste(Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')), true)
  assert.equal(attachesPaste('x'.repeat(1600)), true)
  assert.equal(pastedTextLabel('a\nb\nc\n'), 'Pasted text, 3 lines')
  assert.equal(pastedTextLabel('x'.repeat(1600)), 'Pasted text, 1,600 characters')
})

test('images are known by their extension', () => {
  assert.equal(isImagePath('C:\\shots\\Screen.PNG'), true)
  assert.equal(isImagePath('/a/b/photo.jpeg'), true)
  assert.equal(isImagePath('/a/b/readme.md'), false)
})
