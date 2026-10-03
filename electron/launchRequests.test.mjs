import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { parseAmbioUrl, parseLaunchArgs } from './launchRequests.ts'

// Paths come back resolved the host's way (a drive letter on Windows).
const host = (...parts) => path.resolve(...parts)

test('ambio:// links open a folder or a known project, and nothing else', () => {
  assert.deepEqual(parseAmbioUrl('ambio://open?path=%2Fhome%2Fa%2Frepo'), { kind: 'path', path: host('/home/a/repo') })
  assert.deepEqual(parseAmbioUrl('ambio://project/3f2a-b1'), { kind: 'project', projectId: '3f2a-b1' })
  assert.equal(parseAmbioUrl('ambio://open?path=relative/dir'), null)
  assert.equal(parseAmbioUrl('ambio://project/../../etc'), null)
  assert.equal(parseAmbioUrl('ambio://delete?all=1'), null)
  assert.equal(parseAmbioUrl('https://example.com'), null)
})

test('command lines resolve the first location against the working directory', () => {
  assert.deepEqual(parseLaunchArgs(['/opt/Ambio/ambio', '.'], '/home/a/repo'), { kind: 'path', path: host('/home/a/repo') })
  assert.deepEqual(parseLaunchArgs(['ambio', '--inspect', 'src'], '/home/a/repo'), { kind: 'path', path: host('/home/a/repo', 'src') })
  assert.deepEqual(parseLaunchArgs(['ambio', 'ambio://project/p1'], '/'), { kind: 'project', projectId: 'p1' })
  // Development: electron . passes the app directory itself.
  assert.equal(parseLaunchArgs(['electron', '.'], '/dev/Ambio', ['/dev/Ambio']), null)
  assert.equal(parseLaunchArgs(['ambio'], '/home/a'), null)
})
