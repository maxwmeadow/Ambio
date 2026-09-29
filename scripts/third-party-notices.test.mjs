import assert from 'node:assert/strict'
import test from 'node:test'

import { licenseAllowed } from './third-party-notices.mjs'

test('license policy accepts AGPL-compatible licenses and expressions', () => {
  assert.ok(licenseAllowed('MIT'))
  assert.ok(licenseAllowed('(MIT OR WTFPL)'))
  assert.ok(licenseAllowed('(BSD-2-Clause OR MIT OR Apache-2.0)'))
  assert.ok(licenseAllowed('MIT AND Apache-2.0'))
})

test('license policy stops incompatible or unknown licenses', () => {
  assert.equal(licenseAllowed('EPL-2.0'), false)
  assert.equal(licenseAllowed('GPL-2.0-only'), false)
  assert.equal(licenseAllowed('MIT AND EPL-2.0'), false)
  assert.equal(licenseAllowed(undefined), false)
  assert.equal(licenseAllowed('SEE LICENSE IN LICENSE.txt'), false)
})
