import assert from 'node:assert/strict'
import test from 'node:test'
import { baselineText, changeField, changeKind, changeOwner, ownerText, revertSpec, setBaseline } from './sourceChanges.ts'
import { sourceEditorState } from './sourceEditor.ts'

const open = content => sourceEditorState({ content, range: { start: 1, end: 1 }, dynamic: [], onSave: () => true, onChange: () => {} })
const withBaseline = (state, committed, authors = []) => state.update({
  effects: setBaseline.of({ text: baselineText(committed, state.lineBreak), tracked: true, authors }),
}).state
const summary = state => {
  const field = state.field(changeField)
  return field.chunks.map(chunk => ({ kind: changeKind(chunk), owner: changeOwner(chunk, field), line: state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).number }))
}

test('lines added, changed and removed since the commit are found, in a CRLF file too', () => {
  const state = withBaseline(open('a\r\nB\r\nc\r\nnew\r\n'), 'a\nb\nc\nd\n')
  assert.deepEqual(summary(state), [
    { kind: 'modified', owner: 'other', line: 2 },
    { kind: 'modified', owner: 'other', line: 4 },
  ])
  const removed = withBaseline(open('a\nc\n'), 'a\nb\nc\n')
  assert.deepEqual(summary(removed), [{ kind: 'deleted', owner: 'other', line: 2 }])
  const added = withBaseline(open('a\nb\nc\n'), 'a\nc\n')
  assert.deepEqual(summary(added), [{ kind: 'added', owner: 'other', line: 2 }])
})

test('a change typed in this editor is yours; one already on disk is whoever the journal says', () => {
  const agentOnly = [{ actor: 'agent', agent: 'codex', goal: 'Fix threshold', lastAt: Date.now() - 4 * 60_000, saves: 2 }]
  let state = withBaseline(open('a\nb2\nc\nd\n'), 'a\nb\nc\nd\n', agentOnly)
  assert.deepEqual(summary(state), [{ kind: 'modified', owner: 'agent', line: 2 }])
  // The person edits line 4; line 2 stays the agent's.
  state = state.update({ changes: { from: state.doc.line(4).to, insert: '!' }, userEvent: 'input.type' }).state
  assert.deepEqual(summary(state), [{ kind: 'modified', owner: 'agent', line: 2 }, { kind: 'modified', owner: 'mine', line: 4 }])
  // A change made by Ambio itself, not typed, is not counted as the person's.
  state = state.update({ changes: { from: 0, insert: 'z' } }).state
  assert.equal(summary(state)[0].owner, 'agent')
  // Agents and a person both changed the file: the journal cannot say which lines are whose.
  const mixed = withBaseline(open('a\nb2\n'), 'a\nb\n', [...agentOnly, { actor: 'human', lastAt: Date.now(), saves: 1 }])
  assert.equal(summary(mixed)[0].owner, 'other')
})

test('who changed it reads as a sentence', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  assert.equal(ownerText('mine', []), 'Changed by you in this editor')
  assert.equal(ownerText('other', []), 'Changed since the last commit')
  assert.equal(ownerText('agent', [{ actor: 'agent', agent: 'codex', goal: 'Fix threshold', lastAt: now - 4 * 60_000, saves: 1 }], now),
    'Changed since the last commit by Codex ("Fix threshold"), 4 min ago')
  assert.equal(ownerText('other', [{ actor: 'human', lastAt: now - 3 * 3_600_000, saves: 1 }, { actor: 'agent', agent: 'claude-code', lastAt: now - 2 * 86_400_000, saves: 1 }], now),
    'Changed since the last commit by a person or another editor, 3 h ago; Claude Code, 2 d ago')
})

test('reverting a change puts the committed lines back, with the file\'s own line breaks', () => {
  for (const [content, committed] of [
    ['a\r\nB\r\nc\r\n', 'a\nb\nc\n'],
    ['a\r\nc\r\n', 'a\r\nb\r\nc\r\n'],
    ['a\nextra\nb\n', 'a\nb\n'],
    ['a\nb', 'a\nb\nlast'],
    ['first\nb\n', 'b\n'],
  ]) {
    let state = withBaseline(open(content), committed)
    while (state.field(changeField).chunks.length) state = state.update(revertSpec(state, state.field(changeField).chunks[0])).state
    const expected = state.lineBreak === '\r\n' ? committed.replace(/\r?\n/g, '\r\n') : committed
    assert.equal(state.sliceDoc(), expected, JSON.stringify([content, committed]))
  }
})
