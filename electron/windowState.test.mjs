import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readWindowState, restorableBounds, writeWindowState } from './windowState.ts'

const DISPLAY = [{ x: 0, y: 0, width: 1920, height: 1080 }]
const MIN = { width: 900, height: 600 }

test('window state round-trips and rejects malformed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-window-'))
  const file = path.join(dir, 'window-state.json')
  try {
    assert.equal(readWindowState(file), null)
    writeWindowState(file, { x: 10, y: 20, width: 1200, height: 800, maximized: true })
    assert.deepEqual(readWindowState(file), { x: 10, y: 20, width: 1200, height: 800, maximized: true, fullScreen: false })
    fs.writeFileSync(file, '{"x":"left"}')
    assert.equal(readWindowState(file), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bounds on a disconnected monitor are not restored', () => {
  const onScreen = { x: 100, y: 100, width: 1200, height: 800, maximized: false }
  assert.deepEqual(restorableBounds(onScreen, DISPLAY, MIN), { x: 100, y: 100, width: 1200, height: 800 })
  assert.equal(restorableBounds({ ...onScreen, x: 3000 }, DISPLAY, MIN), null)
  assert.equal(restorableBounds(null, DISPLAY, MIN), null)
  assert.equal(restorableBounds({ ...onScreen, width: 200 }, DISPLAY, MIN).width, 900)
})
