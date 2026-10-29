import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBranchChip, buildBranchRows, buildCanvasOverlay, buildCheckoutRows, buildRepositoryRows, checkoutName, checkoutState, buildSync, collisionsBySystem, conversationWorkplace, homePath, overlaySummary, timeAgo } from './checkoutModel.ts'

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

test('large checkout arrivals preserve order and inputs across repeated lens projections', () => {
  const overlay = Object.freeze(Array.from({ length: 20000 }, (_, i) => Object.freeze({
    path: `src/new-${i}.ts`, change: 'added', systemId: 'canvas',
  })))
  const source = snapshot([checkout(), checkout({ rootId: 'other', isFocused: false, overlay,
    agents: [{ sessionId: 'work' }] })])
  const projected = buildCanvasOverlay(source, 'all')
  const paths = projected.arrivals.get('canvas')[0].paths
  assert.equal(paths.length, 20000)
  assert.equal(paths[0], 'src/new-0.ts')
  assert.equal(paths.at(-1), 'src/new-19999.ts')
  assert.equal(overlay.length, 20000)
  assert.deepEqual(buildCanvasOverlay(source, 'agents').arrivals, projected.arrivals)
  assert.equal(buildCanvasOverlay(source, 'off').arrivals.size, 0)
})

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

test('a conversation working away from the project checkout names its worktree', () => {
  const worktree = checkout({ rootId: 'run', path: '/home/me/.ambio/worktrees/shop/fix-login', branch: 'ambio/fix-login', isPrimary: false, isFocused: false, isAmbioRun: true })
  const checkouts = [checkout(), worktree]
  const run = (rootPath, startedAt = 1) => ({ rootPath, startedAt })
  // Working here, or not started yet, says nothing.
  assert.equal(conversationWorkplace([run('/code/shop'), undefined], '/code/shop', checkouts), '')
  assert.equal(conversationWorkplace([], '/code/shop', checkouts), '')
  // The latest turn that ran elsewhere decides; a trailing separator is the same folder.
  assert.equal(conversationWorkplace([run('/code/shop', 1), run('/home/me/.ambio/worktrees/shop/fix-login/', 2)], '/code/shop/', checkouts), 'in ambio/fix-login')
  // A worktree the snapshot does not list yet is named by its folder.
  assert.equal(conversationWorkplace([run('C:\\worktrees\\shop\\fix-login')], 'C:\\code\\shop', []), 'in fix-login')
  // The primary checkout under another spelling is still here.
  assert.equal(conversationWorkplace([run('/code/shop-link')], '/code/shop', [checkout({ path: '/code/shop-link' })]), '')
})

test('the Floor\'s branch says where it stands against its remote and offers the one action that calls for', () => {
  const now = Date.parse('2026-10-28T20:00:00Z')
  const tracked = overrides => buildSync(checkout({ upstream: 'origin/main', fetchedAt: now - 2 * 60000, publishRemote: 'origin', ...overrides }), now)

  const behind = tracked({ behind: 3 })
  assert.equal(behind.state, 'behind')
  assert.equal(behind.headline, '3 commits to pull')
  assert.equal(behind.remote, 'origin/main')
  assert.deepEqual(behind.action, { kind: 'pull', label: 'Pull 3 commits' })
  assert.equal(behind.checked, 'Checked 2 min ago')
  assert.equal(behind.canCheck, true)

  const ahead = tracked({ ahead: 1 })
  assert.equal(ahead.state, 'ahead')
  assert.deepEqual(ahead.action, { kind: 'push', label: 'Push 1 commit' })

  const current = tracked({})
  assert.equal(current.state, 'current')
  assert.equal(current.headline, 'Up to date')
  assert.equal(current.detail, 'Nothing to pull from or push to origin/main.')
  assert.equal(current.action, undefined)

  // Both sides moved: a merge, not a pull, so no action.
  const diverged = tracked({ ahead: 2, behind: 1 })
  assert.equal(diverged.state, 'diverged')
  assert.match(diverged.detail, /^1 commit to pull and 2 commits to push, so this needs a merge/)
  assert.equal(diverged.action, undefined)

  // No upstream: publish where there is an obvious remote, else say it is local.
  const unpublished = buildSync(checkout({ branch: 'idea', publishRemote: 'origin' }), now)
  assert.equal(unpublished.state, 'unpublished')
  assert.equal(unpublished.remote, 'origin')
  assert.equal(unpublished.detail, 'idea is only on this computer.')
  assert.deepEqual(unpublished.action, { kind: 'publish', label: 'Publish to origin' })
  assert.equal(unpublished.checked, 'Not checked yet')
  const local = buildSync(checkout({}), now)
  assert.equal(local.state, 'local')
  assert.equal(local.canCheck, false)
  assert.equal(local.checked, '')
  assert.equal(local.action, undefined)

  assert.equal(tracked({ changedFiles: 4 }).uncommitted, 4)

  // Without a branch to sync, the checkout's own state is the headline.
  const detached = buildSync(checkout({ headState: 'detached', branch: '(detached)', headCommit: 'abcdef1234' }), now)
  assert.equal(detached.state, 'other')
  assert.match(detached.headline, /^Detached at/)
  assert.equal(detached.action, undefined)
  assert.equal(buildSync(undefined).headline, '')
})

test('a home folder is written as ~', () => {
  assert.equal(homePath('/Users/maximmeadow/dev/CSE498/Magna'), '~/dev/CSE498/Magna')
  assert.equal(homePath('/home/dev/.codex/worktrees/a1b2/ambio'), '~/.codex/worktrees/a1b2/ambio')
  assert.equal(homePath('C:\\Users\\Max\\code\\shop'), '~\\code\\shop')
  assert.equal(homePath('/code/ambio'), '/code/ambio')
  assert.equal(homePath('/Users/maxim-other'), '~')
})

test('time since is said in a few words', () => {
  const now = Date.parse('2026-10-28T20:00:00Z')
  assert.equal(timeAgo(now - 10_000, now), 'just now')
  assert.equal(timeAgo(now - 5 * 60000, now), '5 min ago')
  assert.equal(timeAgo(now - 3 * 3600000, now), '3 h ago')
  assert.equal(timeAgo(now - 26 * 3600000, now), '1 day ago')
  assert.equal(timeAgo(now + 60000, now), 'just now')
})

test('the branch list puts the Floor first, narrows by what was typed and offers a new branch', () => {
  const now = Date.UTC(2026, 9, 29)
  const listing = { current: 'main', branches: [
    { name: 'fix/retry', upstream: 'origin/fix/retry', behind: 2, committedAt: now - 3 * 86_400_000, subject: 'Retry' },
    { name: 'main', rootId: 'root_main', upstream: 'origin/main' },
    { name: 'spike', rootId: 'root_spike', gone: true },
  ] }
  const all = buildBranchRows(listing, '', now)
  assert.deepEqual(all.rows.map(row => row.name), ['main', 'fix/retry', 'spike'])
  assert.equal(all.create, null)
  assert.equal(all.rows[0].rootId, undefined, "the Floor's own checkout is not another worktree")
  assert.equal(all.rows[1].last, '3 days ago · Retry')
  assert.equal(all.rows[2].rootId, 'root_spike')
  assert.equal(all.rows[2].gone, true)
  const typed = buildBranchRows(listing, 'RETRY', now)
  assert.deepEqual(typed.rows.map(row => row.name), ['fix/retry'])
  assert.equal(typed.create, 'RETRY')
  assert.equal(buildBranchRows(listing, ' new idea ', now).create, 'new-idea')
  assert.equal(buildBranchRows(listing, 'main', now).create, null)
  assert.deepEqual(buildBranchRows(null, 'x', now), { rows: [], create: null })
})
