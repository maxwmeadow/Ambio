import assert from 'node:assert/strict'
import test from 'node:test'

import { changelogSection, isNewer, shouldShowWhatsNew } from './whatsNew.ts'

const CHANGELOG = `# Changelog\n\n## [Unreleased]\n- next\n\n## [0.2.0] - 2026-10-01\n### Added\n- Menus\n\n## [0.1.0]\n- First\n`

test('finds the section for a version', () => {
  assert.equal(changelogSection(CHANGELOG, '0.2.0'), '### Added\n- Menus')
  assert.equal(changelogSection(CHANGELOG, '0.1.0'), '- First')
  assert.equal(changelogSection(CHANGELOG, 'Unreleased'), '- next')
  assert.equal(changelogSection(CHANGELOG, '9.9.9'), null)
})

test('shows only after an update, never on a fresh install or downgrade', () => {
  assert.ok(isNewer('0.10.0', '0.9.3'))
  assert.equal(isNewer('0.2.0', '0.2.0'), false)
  assert.equal(shouldShowWhatsNew('0.2.0', null), false)
  assert.equal(shouldShowWhatsNew('0.2.0', '0.1.0'), true)
  assert.equal(shouldShowWhatsNew('0.1.0', '0.2.0'), false)
})
