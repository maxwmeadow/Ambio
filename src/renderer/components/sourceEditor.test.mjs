import assert from 'node:assert/strict'
import test from 'node:test'
import { lineSeparatorOf, sourceEditorState } from './sourceEditor.ts'

const open = (content, range = { start: 1, end: 1 }) => sourceEditorState({ content, range, dynamic: [], onSave: () => true, onChange: () => {} })

// What is saved is state.sliceDoc(), which joins lines with the file's separator.
test('a file comes back byte for byte, whatever its line endings', () => {
  for (const content of [
    'a\nb\n',
    'a\r\nb\r\n',
    'a\r\nb\nc\r\n', // mostly CRLF with a stray LF
    'a\nb\r\nc\n', // mostly LF with a stray CRLF
    'old\rmac\n',
    'no newline at end',
    'line' + String.fromCharCode(0x2028) + 'separator inside a string\n',
    '',
  ]) {
    assert.equal(open(content).sliceDoc(), content, JSON.stringify(content))
  }
})

test('reloading from disk changes only what differs and keeps the file\'s line breaks', async () => {
  const { replaceWithin, detectIndent } = await import('./sourceEditor.ts')
  for (const [before, after] of [['a\r\nb\r\nc\r\n', 'a\r\nB!\r\nc\r\nd\r\n'], ['x\ny\n', 'x\n'], ['', 'new\n'], ['keep\n', 'keep\n']]) {
    const state = open(before)
    assert.equal(state.update(replaceWithin(state, after)).state.sliceDoc(), after, JSON.stringify([before, after]))
  }
  // The cursor on an untouched line stays on it.
  const state = open('one\ntwo\nthree\n')
  const placed = state.update({ selection: { anchor: state.doc.line(3).from + 2 } }).state
  const reloaded = placed.update(replaceWithin(placed, 'ONE\ntwo\nthree\n')).state
  assert.equal(reloaded.doc.lineAt(reloaded.selection.main.head).text, 'three')

  assert.deepEqual(detectIndent('def a():\n    if b:\n        c\n'), { unit: '    ', label: 'Spaces: 4' })
  assert.deepEqual(detectIndent('{\n  a\n  {\n    b\n  }\n}\n'), { unit: '  ', label: 'Spaces: 2' })
  assert.deepEqual(detectIndent('func a() {\n\tb()\n\tif c {\n\t\td()\n\t}\n}\n'), { unit: '\t', label: 'Tabs' })
  assert.deepEqual(detectIndent('no indentation\n'), { unit: '    ', label: 'Spaces: 4' })
})

test('the separator is whichever break the file mostly uses', () => {
  assert.equal(lineSeparatorOf('a\r\nb\r\nc\n'), '\r\n')
  assert.equal(lineSeparatorOf('a\nb\nc\r\n'), '\n')
  assert.equal(lineSeparatorOf(''), '\n')
  // Lines are counted by that separator, so line numbers match the file's.
  assert.equal(open('a\r\nb\r\nc').doc.lines, 3)
})

test('a typed line break uses the file\'s own separator', () => {
  const state = open('a\r\nb\r\n')
  const edited = state.update({ changes: { from: 1, insert: state.lineBreak + 'x' } }).state
  assert.equal(edited.sliceDoc(), 'a\r\nx\r\nb\r\n')
})
