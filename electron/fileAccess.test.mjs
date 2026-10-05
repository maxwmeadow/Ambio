import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chooseEditor, detectEditors, isInside, safeForSystemOpen } from './fileAccess.ts'

test('only plain documents go to the system default application', () => {
  assert.ok(safeForSystemOpen('/r/README.md'))
  for (const risky of ['/r/tool.js', '/r/run.sh', '/r/a.py', '/r/b.bat', '/r/c.ps1', '/r/app.exe', '/r/x.command']) {
    assert.equal(safeForSystemOpen(risky), false, risky)
  }
})

test('paths must be inside a registered project', () => {
  assert.ok(isInside('/home/a/repo/src/x.ts', ['/home/a/repo'], 'linux'))
  assert.ok(isInside('/home/a/repo', ['/home/a/repo'], 'linux'))
  assert.equal(isInside('/home/a/repo-other/x.ts', ['/home/a/repo'], 'linux'), false)
  assert.equal(isInside('/home/a/repo/../secrets', ['/home/a/repo'], 'linux'), false)
  assert.equal(isInside('relative/x.ts', ['/home/a/repo'], 'linux'), false)
  assert.equal(isInside('/etc/passwd', [], 'linux'), false)
})

test('editors are found on PATH and chosen by setting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-editors-'))
  try {
    for (const name of ['cursor', 'code']) fs.writeFileSync(path.join(dir, name), '')
    const editors = detectEditors({ PATH: dir, HOME: dir }, 'linux', dir).filter(editor => editor.command.startsWith(dir))
    assert.deepEqual(editors.map(editor => editor.id), ['vscode', 'cursor'])
    assert.equal(chooseEditor('auto', editors).id, 'vscode')
    assert.equal(chooseEditor('cursor', editors).id, 'cursor')
    assert.equal(chooseEditor('zed', editors), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
