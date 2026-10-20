import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBranchChip, buildCheckoutRows, checkoutName, checkoutState, collisionsBySystem } from './checkoutModel.ts'

function checkout(overrides = {}) {
  return {
    rootId: 'main-root', path: '/code/shop', branch: 'main', headCommit: '1234567890abc', headState: 'commit',
    isPrimary: true, isFocused: true, changedFiles: 0, ahead: 0, behind: 0, agents: [],
    touchedSystems: 0, collidingSystems: 0, ...overrides,
  }
}

function snapshot(checkouts, collisions = [], vcs = 'git') {
  return { workspaceId: 'ws', vcs, checkouts, collisions }
}

test('one clean checkout reads as just its branch', () => {
  const chip = buildBranchChip(snapshot([checkout()]))
  assert.equal(chip.visible, true)
  assert.equal(chip.label, 'main')
  assert.equal(chip.dirty, false)
  assert.equal(chip.others, 0)
  assert.equal(chip.title, 'The Floor shows main')
})

test('the chip follows the Floor’s checkout, not the first one listed', () => {
  const chip = buildBranchChip(snapshot([
    checkout({ rootId: 'agent', branch: 'agent', isFocused: false, isPrimary: false, agents: [{ sessionId: 's', agent: 'codex', goal: 'x', startedAt: 1 }] }),
    checkout({ changedFiles: 2, ahead: 1, upstream: 'origin/main' }),
  ], [{ systemId: 'db', systemName: 'Storage', branches: [] }]))
  assert.equal(chip.label, 'main')
  assert.equal(chip.dirty, true)
  assert.equal(chip.ahead, 1)
  assert.equal(chip.others, 1)
  assert.equal(chip.agents, 1)
  assert.equal(chip.collisions, 1)
  assert.match(chip.title, /2 uncommitted · 1 ahead · of origin\/main/)
  assert.match(chip.title, /1 system changing on more than one branch/)
})

test('odd states are written as states, not errors', () => {
  assert.equal(checkoutName(checkout({ headState: 'none', branch: '', headCommit: '' })), 'No Git')
  assert.equal(checkoutName(checkout({ headState: 'detached', branch: '(detached)' })), '1234567 (detached)')
  assert.equal(checkoutName(checkout({ headState: 'unborn', headCommit: '' })), 'main')
  assert.match(checkoutState(checkout({ headState: 'unborn' })), /No commits yet/)
  assert.match(checkoutState(checkout({ headState: 'none' })), /Ambio’s own record/)
  const plain = buildBranchChip(snapshot([checkout({ headState: 'none', branch: '', headCommit: '' })], [], 'none'))
  assert.equal(plain.plain, true)
  assert.equal(plain.title, 'This folder is not a Git repository')
})

test('a missing snapshot hides the chip and transport gaps never throw', () => {
  assert.equal(buildBranchChip(null).visible, false)
  assert.deepEqual(buildCheckoutRows({ workspaceId: 'ws' }), [])
  assert.equal(collisionsBySystem({ workspaceId: 'ws', checkouts: [checkout()] }).size, 0)
})

test('collisions are keyed by system and name each branch the way the chip does', () => {
  const collisions = collisionsBySystem(snapshot([
    checkout(),
    checkout({ rootId: 'agent', branch: '(detached)', headState: 'detached', headCommit: 'abcdef123', isFocused: false }),
  ], [{
    systemId: 'db', systemName: 'Storage', branches: [
      { rootId: 'main-root', branch: 'main', files: ['db.go'], claims: [{ title: 'internal', internal: true }, { title: 'Storage now calls Cache' }] },
      { rootId: 'agent', branch: '(detached)', files: ['db.go', 'pool.go'], claims: [] },
    ],
  }]))
  assert.deepEqual(collisions.get('db').map(branch => [branch.name, branch.focused, branch.claim]), [
    ['main', true, 'Storage now calls Cache'],
    ['abcdef1 (detached)', false, '2 changed files'],
  ])
})
