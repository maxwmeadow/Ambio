import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS, normalizeSettings, patchSettings } from './appSettings.ts'

test('missing or malformed settings fall back to defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ reopenLastProject: 'yes', uiZoom: 'big', reduceMotion: 'sometimes' }), DEFAULT_SETTINGS)
})

test('patches are validated and zoom is clamped', () => {
  const next = patchSettings(DEFAULT_SETTINGS, { uiZoom: 9, reduceMotion: 'always', checkForUpdates: false })
  assert.equal(next.uiZoom, 1.5)
  assert.equal(next.reduceMotion, 'always')
  assert.equal(next.checkForUpdates, false)
  assert.equal(patchSettings(DEFAULT_SETTINGS, { uiZoom: 0.1 }).uiZoom, 0.8)
  assert.equal(patchSettings(DEFAULT_SETTINGS, { uiZoom: 1.1000000001 }).uiZoom, 1.1)
})
