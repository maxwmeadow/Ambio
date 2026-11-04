import assert from 'node:assert/strict'
import test from 'node:test'
import { askAboutLines, lineSeparatorOf, sourceEditorState } from './sourceEditor.ts'

test('asking an agent about lines names where they are and quotes them safely', () => {
  assert.equal(askAboutLines('robot/heuristics.py', 114, 114, 'is_moving = speed > 0.1\r\n'),
    'About `robot/heuristics.py:114`:\n\n```python\nis_moving = speed > 0.1\n```\n\n')
  // Code holding its own fence gets a longer one, so it cannot end the quote early.
  assert.equal(askAboutLines('docs/a.md', 3, 5, 'x\n```js\ny\n```'), 'About `docs/a.md:3-5`:\n\n````markdown\nx\n```js\ny\n```\n````\n\n')
  // An unknown language is still fenced.
  assert.match(askAboutLines('notes.zzz', 1, 1, 'z'), /^About `notes\.zzz:1`:\n\n```\nz\n```/)
  const long = Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n')
  const asked = askAboutLines('a.ts', 1, 250, long)
  assert.ok(asked.includes('l199\n```\n(First 200 of 250 lines; read the file for the rest.)'))
  assert.ok(!asked.includes('l200'))
})

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
