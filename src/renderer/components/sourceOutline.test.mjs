import assert from 'node:assert/strict'
import test from 'node:test'
import { definitionInFile, enclosingSymbols, outlineField, outlineFromSymbols, setOutline } from './sourceOutline.ts'
import { sourceEditorState } from './sourceEditor.ts'

const content = 'class Scene:\n    def update(self):\n        run()\n\n    def draw(self):\n        pass\n\ndef update():\n    pass\n'
const symbols = [
  { name: 'Scene', kind: 'class', lineStart: 1, lineEnd: 6 },
  { name: 'update', kind: 'method', lineStart: 2, lineEnd: 3 },
  { name: 'draw', kind: 'method', lineStart: 5, lineEnd: 6 },
  { name: 'update', kind: 'function', lineStart: 8, lineEnd: 9 },
  { name: 'LIMIT', kind: 'variable', lineStart: 1, lineEnd: 1 },
]
const open = () => {
  const state = sourceEditorState({ content, range: { start: 1, end: 1 }, dynamic: [], onSave: () => true, onChange: () => {} })
  return state.update({ effects: setOutline.of(outlineFromSymbols(state.doc, symbols)) }).state
}
const names = (state, line, column = 4) => enclosingSymbols(state.field(outlineField), state.doc.line(line).from + column).map(symbol => symbol.name)

test('the breadcrumb names the classes and functions around the cursor, outermost first', () => {
  const state = open()
  assert.deepEqual(names(state, 3), ['Scene', 'update'])
  assert.deepEqual(names(state, 6), ['Scene', 'draw'])
  assert.deepEqual(names(state, 9), ['update'])
  assert.deepEqual(names(state, 7, 0), [])
})

test('the outline stays on its code as lines are added above it', () => {
  let state = open()
  state = state.update({ changes: { from: 0, insert: 'import os\n\n' } }).state
  assert.deepEqual(names(state, 5), ['Scene', 'update'])
  assert.equal(state.doc.lineAt(state.field(outlineField).find(symbol => symbol.name === 'draw').from).number, 7)
})

test('a definition in the same file is found when it is the only one, or its own line was clicked', () => {
  const state = open()
  const outline = state.field(outlineField)
  assert.equal(definitionInFile(outline, 'draw', 0, state.doc).from, state.doc.line(5).from)
  // Two "update"s: a call elsewhere is not guessed; clicking a definition's own line is that one.
  assert.equal(definitionInFile(outline, 'update', state.doc.line(3).from, state.doc), null)
  assert.equal(definitionInFile(outline, 'update', state.doc.line(8).from + 5, state.doc).from, state.doc.line(8).from)
  assert.equal(definitionInFile(outline, 'missing', 0, state.doc), null)
})
