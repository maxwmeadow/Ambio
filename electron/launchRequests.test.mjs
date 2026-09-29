import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { parseAxiomUrl, parseLaunchArgs } from './launchRequests.ts'

// Paths come back resolved the host's way (a drive letter on Windows).
const host = (...parts) => path.resolve(...parts)

test('axiom:// links open a folder or a known project, and nothing else', () => {
  assert.deepEqual(parseAxiomUrl('axiom://open?path=%2Fhome%2Fa%2Frepo'), { kind: 'path', path: host('/home/a/repo') })
  assert.deepEqual(parseAxiomUrl('axiom://project/3f2a-b1'), { kind: 'project', projectId: '3f2a-b1' })
  assert.equal(parseAxiomUrl('axiom://open?path=relative/dir'), null)
  assert.equal(parseAxiomUrl('axiom://project/../../etc'), null)
  assert.equal(parseAxiomUrl('axiom://delete?all=1'), null)
  assert.equal(parseAxiomUrl('https://example.com'), null)
})

test('command lines resolve the first location against the working directory', () => {
  assert.deepEqual(parseLaunchArgs(['/opt/Axiom/axiom', '.'], '/home/a/repo'), { kind: 'path', path: host('/home/a/repo') })
  assert.deepEqual(parseLaunchArgs(['axiom', '--inspect', 'src'], '/home/a/repo'), { kind: 'path', path: host('/home/a/repo', 'src') })
  assert.deepEqual(parseLaunchArgs(['axiom', 'axiom://project/p1'], '/'), { kind: 'project', projectId: 'p1' })
  // Development: electron . passes the app directory itself.
  assert.equal(parseLaunchArgs(['electron', '.'], '/dev/Axiom', ['/dev/Axiom']), null)
  assert.equal(parseLaunchArgs(['axiom'], '/home/a'), null)
})
