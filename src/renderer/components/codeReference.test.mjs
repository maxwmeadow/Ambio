import assert from 'node:assert/strict'
import test from 'node:test'
import { adjacentLines, codeReferenceFromAmbioHref, codeReferenceFromHref, codeReferenceFromText, codeReferenceHref, parseCodeLocation, resolveProjectPath } from './codeReference.ts'

const files = new Set(['robot/heuristics.py', 'robot/server.py', 'src/App.cs', 'web/src/Chat.tsx', 'a/utils.py', 'b/utils.py'])
const root = 'C:\\Users\\me\\robot-proj'

test('every location style clients write reads as the same line range', () => {
  const cases = {
    'heuristics.py:114': { line: 114 },
    'heuristics.py:114:9': { line: 114 },
    'heuristics.py:114-120': { line: 114, endLine: 120 },
    'heuristics.py:114\u2013120': { line: 114, endLine: 120 },
    'heuristics.py:114:3-120:1': { line: 114, endLine: 120 },
    'heuristics.py#L114': { line: 114 },
    'heuristics.py#L114-L120': { line: 114, endLine: 120 },
    'heuristics.py#L114C3-L120C9': { line: 114, endLine: 120 },
    'heuristics.py(114)': { line: 114 },
    'heuristics.py(114,5)': { line: 114 },
    'heuristics.py line 114': { line: 114 },
    'heuristics.py, lines 114-120': { line: 114, endLine: 120 },
    'heuristics.py (line 114)': { line: 114 },
    'heuristics.py L114': { line: 114 },
    'heuristics.py': {},
  }
  for (const [written, lines] of Object.entries(cases)) {
    assert.deepEqual(parseCodeLocation(written), { path: 'heuristics.py', ...lines }, written)
  }
  // Line 0 and a backwards range are not locations a person can be taken to.
  assert.deepEqual(parseCodeLocation('a.py:0'), { path: 'a.py' })
  assert.deepEqual(parseCodeLocation('a.py:20-10'), { path: 'a.py', line: 20 })
})

test('a path resolves to one indexed file, or to none when it could be several', () => {
  assert.equal(resolveProjectPath('robot/heuristics.py', files), 'robot/heuristics.py')
  assert.equal(resolveProjectPath('heuristics.py', files), 'robot/heuristics.py')
  assert.equal(resolveProjectPath('.\\robot\\heuristics.py', files), 'robot/heuristics.py')
  assert.equal(resolveProjectPath('ROBOT/Heuristics.py', files), 'robot/heuristics.py')
  assert.equal(resolveProjectPath('@robot/server.py', files), 'robot/server.py')
  assert.equal(resolveProjectPath('C:/Users/me/robot-proj/robot/server.py', files, root), 'robot/server.py')
  assert.equal(resolveProjectPath('/c:/users/me/robot-proj/src/App.cs', files, root), 'src/App.cs')
  assert.equal(resolveProjectPath('utils.py', files), null)
  assert.equal(resolveProjectPath('ristics.py', files), null)
  assert.equal(resolveProjectPath('evaluate_scene', files), null)
})

test('links from each client resolve, and web links do not', () => {
  const expected = { relPath: 'robot/heuristics.py', line: 114 }
  for (const href of [
    'file:///C:/Users/me/robot-proj/robot/heuristics.py#L114',
    'vscode://file/C:/Users/me/robot-proj/robot/heuristics.py:114:5',
    'cursor://file/C:/Users/me/robot-proj/robot/heuristics.py:114',
    'robot/heuristics.py:114',
    './robot/heuristics.py#L114',
    'C:\\Users\\me\\robot-proj\\robot\\heuristics.py:114',
    'robot/heuristics%2Epy:114',
  ]) assert.deepEqual(codeReferenceFromHref(href, files, root), expected, href)
  for (const href of ['https://github.com/o/r/blob/main/robot/heuristics.py#L114', 'mailto:a@b.c', 'ambio://sheet/x', '#heuristics', undefined]) {
    assert.equal(codeReferenceFromHref(href, files, root), null, String(href))
  }
})

test('a resolved reference survives its round trip through the rendered link', () => {
  for (const reference of [{ relPath: 'web/src/Chat.tsx' }, { relPath: 'robot/heuristics.py', line: 114 }, { relPath: 'robot/a b#c.py', line: 3, endLine: 9 }]) {
    assert.deepEqual(codeReferenceFromAmbioHref(codeReferenceHref(reference)), reference)
  }
  assert.equal(codeReferenceFromAmbioHref('ambio://sheet/x'), null)
  assert.deepEqual(codeReferenceFromText('`nope`', files), null)
})

test('a line written beside the file name in the sentence is found', () => {
  assert.deepEqual(adjacentLines('', ' line 114 is dead'), { line: 114 })
  assert.deepEqual(adjacentLines('', ' (lines 3-9)'), { line: 3, endLine: 9 })
  assert.deepEqual(adjacentLines('', ', at line 40'), { line: 40 })
  assert.deepEqual(adjacentLines('see line 114 of ', ''), { line: 114 })
  assert.deepEqual(adjacentLines('lines 3 to 9 in ', ''), { line: 3, endLine: 9 })
  assert.equal(adjacentLines('', ' has 114 lines'), null)
  assert.equal(adjacentLines('the outline ', ''), null)
})
