import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBranchChip, buildCanvasOverlay, buildCheckoutRows, buildRepositoryRows, checkoutName, checkoutState, collisionsBySystem, overlaySummary } from './checkoutModel.ts'

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

test('the lens decides which other checkouts the Floor draws', () => {
  const agent = checkout({
    rootId: 'agent', branch: 'codex/retry', isFocused: false, isPrimary: false,
    agents: [{ sessionId: 's', agent: 'codex', goal: 'Retry', startedAt: 1 }],
    overlay: [
      { path: 'pay/retry.go', change: 'added', systemId: 'sys_pay' },
      { path: 'pay/stripe.go', change: 'modified', fileId: 'file_stripe', systemId: 'sys_pay' },
      { path: 'old.go', change: 'deleted', fileId: 'file_old' },
      { path: 'tools/new.go', change: 'added' },
    ],
  })
  const idle = checkout({
    rootId: 'idle', branch: 'old-experiment', isFocused: false, isPrimary: false,
    overlay: [{ path: 'pay/stripe.go', change: 'deleted', fileId: 'file_stripe' }],
  })
  const all = snapshot([checkout({ overlay: [] }), agent, idle])

  assert.equal(buildCanvasOverlay(all, 'off').shown.length, 0)
  const agents = buildCanvasOverlay(all, 'agents')
  assert.deepEqual(agents.shown.map(item => item.rootId), ['agent'])
  assert.deepEqual(agents.arrivals.get('sys_pay').map(arrival => arrival.paths), [['pay/retry.go']])
  assert.deepEqual(agents.byFile.get('file_stripe').map(mark => [mark.name, mark.change]), [['codex/retry', 'modified']])
  assert.equal(agents.byFile.get('file_old')[0].change, 'deleted')
  assert.equal(agents.unplaced, 1)

  const everything = buildCanvasOverlay(all, 'all')
  assert.deepEqual(everything.byFile.get('file_stripe').map(mark => mark.change), ['modified', 'deleted'])
  assert.notEqual(everything.byFile.get('file_stripe')[0].tint, everything.byFile.get('file_stripe')[1].tint)
  assert.equal(overlaySummary(agent), '+2 ~1 −1 files')
  assert.equal(overlaySummary(checkout({ overlay: [], overlayTruncated: 0 })), '')
})

test('a folder of repositories reads as how many, and lists each', () => {
  const repos = {
    workspaceId: 'ws', vcs: 'repos', collisions: [],
    checkouts: [checkout({ branch: '', headCommit: '', headState: 'none' })],
    repositories: [
      { folder: 'web', branch: 'redesign', headCommit: 'abc', headState: 'commit', changedFiles: 1, ahead: 0, behind: 0 },
      { folder: 'services/api', branch: 'main', headCommit: 'def', headState: 'commit', changedFiles: 0, ahead: 2, behind: 0, upstream: 'origin/main' },
    ],
  }
  const chip = buildBranchChip(repos)
  assert.equal(chip.label, '2 repos')
  assert.equal(chip.dirty, true)
  assert.equal(chip.title, 'web on redesign (1 uncommitted). services/api on main')
  assert.deepEqual(buildRepositoryRows(repos).map(row => [row.folder, row.name, row.state]), [
    ['web', 'redesign', '1 uncommitted'],
    ['services/api', 'main', '2 ahead · of origin/main'],
  ])
})
