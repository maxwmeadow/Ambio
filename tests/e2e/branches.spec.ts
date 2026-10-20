import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { skipAgentGuides } from './agentGuides'

// The branch chip, its Checkouts popover and collision marks on systems
// (docs/GIT_AND_PROJECT_SHAPES.md "The experience"), against the fixture
// graph with archd's /api/checkouts answered here.

let app: ElectronApplication
let page: Page
let e2eHome: string

const SHOTS = process.env.AMBIO_E2E_SHOTS

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    rootId: 'root_demo', path: '/code/ambio', branch: 'main', headCommit: '9fc31ab4470e', headState: 'commit',
    isPrimary: true, isFocused: true, changedFiles: 0, ahead: 0, behind: 0, agents: [],
    touchedSystems: 0, collidingSystems: 0, overlay: [], ...overrides,
  }
}

const PARALLEL = {
  workspaceId: 'demo',
  vcs: 'git',
  checkouts: [
    checkout({ changedFiles: 2, ahead: 1, upstream: 'origin/main', touchedSystems: 1, collidingSystems: 1 }),
    checkout({
      rootId: 'root_agent', path: '/home/dev/.codex/worktrees/a1b2/ambio', branch: 'codex/retry-checkout',
      headCommit: 'b81e2f0c991a', isPrimary: false, isFocused: false, changedFiles: 4,
      agents: [{ sessionId: 's1', agent: 'codex', goal: 'Retry failed checkout payments', startedAt: 1 }],
      touchedSystems: 2, collidingSystems: 1,
      overlay: [
        { path: 'src/renderer/canvas/AmbioCanvas.tsx', change: 'modified', fileId: 'file_canvas', systemId: 'sys_canvas' },
        { path: 'src/renderer/store/graphStore.ts', change: 'deleted', fileId: 'file_store', systemId: 'sys_canvas' },
        { path: 'src/renderer/canvas/RetryBanner.tsx', change: 'added', systemId: 'sys_canvas' },
      ],
    }),
  ],
  collisions: [{
    systemId: 'sys_canvas', systemName: 'Canvas', branches: [
      { rootId: 'root_demo', branch: 'main', files: ['src/renderer/canvas/AmbioCanvas.tsx'], claims: [] },
      { rootId: 'root_agent', branch: 'codex/retry-checkout', files: ['src/renderer/canvas/AmbioCanvas.tsx', 'src/renderer/store/graphStore.ts'], claims: [{ title: 'Canvas now calls Retry Worker' }] },
    ],
  }],
}

const REVIEW = {
  workspaceId: 'demo', rootId: 'root_agent', branch: 'codex/retry-checkout', headCommit: 'b81e2f0c991a',
  base: 'main', baseCommit: '9fc31ab4470e', files: 3,
  claims: [
    { id: 'c1', kind: 'new_coupling', title: 'Canvas Renderer now depends on Job Queue', subtitle: 'AmbioCanvas.tsx imports retry.ts', severity: 3, score: 1, actor: 'agent', ts: 1, createsCycle: false, internal: false, focusSystemIds: ['sys_canvas'], evidence: [] },
    { id: 'c2', kind: 'files_added', title: 'Canvas Renderer gained RetryBanner.tsx', subtitle: '1 new file', severity: 1, score: 0.5, actor: 'agent', ts: 2, createsCycle: false, internal: false, focusSystemIds: ['sys_canvas'], evidence: [] },
  ],
}

const PLAIN = {
  workspaceId: 'demo', vcs: 'none', collisions: [],
  checkouts: [checkout({ branch: '', headCommit: '', headState: 'none' })],
}

let focusRequests: unknown[] = []

async function launch(checkouts: unknown) {
  focusRequests = []
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  e2eHome = mkdtempSync(join(tmpdir(), 'ambio-e2e-home-'))
  mkdirSync(join(e2eHome, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(join(e2eHome, 'AppData', 'Local'), { recursive: true })
  const root = join(e2eHome, 'ambio-e2e')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{ "name": "ambio-e2e" }\n')
  mkdirSync(join(e2eHome, '.ambio'), { recursive: true })
  writeFileSync(join(e2eHome, '.ambio', 'projects.json'), JSON.stringify([{
    id: 'demo', name: 'Ambio Canvas Fixture', rootPath: root, ignoredPaths: [], languageOverrides: {},
    layoutPreferences: { zoom: 1, panX: 0, panY: 0 }, openedAt: 2,
  }]))
  app = await electron.launch({
    args: ['.'],
    env: { ...env, AMBIO_E2E: '1', AMBIO_E2E_ROOT: root, HOME: e2eHome, USERPROFILE: e2eHome, APPDATA: join(e2eHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(e2eHome, 'AppData', 'Local') },
  })
  page = await app.firstWindow()
  await skipAgentGuides(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
    const url = route.request().url()
    if (url.includes('/api/checkouts/focus')) focusRequests.push(route.request().postDataJSON())
    const body = url.includes('/api/checkouts/focus') ? { ok: true }
      : url.includes('/api/checkouts/review?') ? REVIEW
      : url.includes('/api/checkouts?') ? checkouts
      : url.includes('/api/canvas/history') ? { messages: [], nextCursor: '', availableCount: 0 }
      : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.reload()
  await skipAgentGuides(page)
}

test.afterEach(async () => {
  await app?.close()
  if (e2eHome) rmSync(e2eHome, { recursive: true, force: true })
})

test('the branch chip shows the Floor’s branch and opens every checkout', async () => {
  await launch(PARALLEL)
  const chip = page.locator('.ambio-branch-chip')
  await expect(chip).toContainText('main')
  await expect(chip.locator('.ambio-branch-chip__dirty')).toBeVisible()
  await expect(chip).toContainText('↑1')
  await expect(chip).toContainText('+1 worktree')
  await expect(chip.locator('.ambio-branch-chip__collisions')).toHaveText('1 shared')
  // The floating lane this replaces never opens on its own.
  await expect(page.locator('.ambio-agent-lane')).toHaveCount(0)
  if (SHOTS) await page.locator('.ambio-toolbar').screenshot({ path: join(SHOTS, 'branch-chip.png') })

  await page.keyboard.press('ControlOrMeta+Shift+B')
  const popover = page.getByRole('dialog', { name: 'Branches and worktrees' })
  await expect(popover).toBeVisible()
  const rows = popover.locator('.ambio-checkout')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('on the Floor')
  await expect(rows.first()).toContainText('2 uncommitted · 1 ahead · of origin/main')
  await expect(rows.nth(1)).toContainText('codex/retry-checkout')
  await expect(rows.nth(1)).toContainText('Retry failed checkout payments')
  await expect(rows.nth(1)).toContainText('1 shared with another branch')
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'checkouts-popover.png') })
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
})

test('a system another branch is changing says so on the map and in Properties', async () => {
  await launch(PARALLEL)
  // The collapsed identity and the open tab band each carry the mark; the one
  // for the current zoom must be the one you see.
  const badge = page.locator('.react-flow__node[data-id="sys_canvas"] .ambio-system-collision').filter({ visible: true }).first()
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText('1')
  await expect(badge).toHaveAttribute('title', /Also changing on codex\/retry-checkout/)
  await expect(page.locator('.react-flow__node[data-id="sys_daemon"] .ambio-system-collision')).toHaveCount(0)

  await page.evaluate(() => {
    const store = (window as unknown as { __ambioGraphStore: { getState: () => { setSelectedNode: (id: string) => void; setInspectedNode: (id: string) => void } } }).__ambioGraphStore
    store.getState().setSelectedNode('sys_canvas')
    store.getState().setInspectedNode('sys_canvas')
  })
  const section = page.locator('.ambio-inspector-section', { hasText: 'Changing on other branches' })
  await expect(section).toContainText('codex/retry-checkout')
  await expect(section).toContainText('Canvas now calls Retry Worker')
  await expect(section).toContainText('may conflict when they merge')
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'system-collision.png') })
})

test('a folder without Git reads as a state, not an error', async () => {
  await launch(PLAIN)
  const chip = page.locator('.ambio-branch-chip')
  await expect(chip).toContainText('No Git')
  await expect(chip).toHaveAttribute('title', 'This folder is not a Git repository')
  await chip.click()
  await expect(page.getByRole('dialog', { name: 'Branches and worktrees' })).toContainText('Ambio’s own record')
})

test('another branch’s work is drawn on the Floor until the lens turns it off', async () => {
  await launch(PARALLEL)
  const rail = page.locator('.react-flow__node[data-id="sys_canvas"] .ambio-branch-arrivals')
  await expect(rail).toBeVisible()
  await expect(rail).toContainText('RetryBanner.tsx')
  await expect(rail).toContainText('codex/retry-checkout')
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'overlay-rail.png') })

  // File cards mount once their system opens; search flies to one.
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('textbox', { name: 'Search the map' }).fill('src/renderer/canvas/AmbioCanvas.tsx')
  await page.getByRole('option').first().click()
  const modified = page.locator('.react-flow__node[data-id="file_canvas"] .ambio-branch-overlay-mark[data-change="modified"]')
  await expect(modified).toBeVisible()
  await expect(modified).toHaveAttribute('title', 'Changed on codex/retry-checkout')
  await expect(page.locator('.react-flow__node[data-id="file_store"] .ambio-branch-overlay-mark[data-change="deleted"]')).toBeAttached()
  await page.waitForTimeout(900)
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'overlay-files.png') })
  await page.keyboard.press('Escape')

  await page.keyboard.press('ControlOrMeta+Shift+B')
  const popover = page.getByRole('dialog', { name: 'Branches and worktrees' })
  await expect(popover.locator('.ambio-checkout').nth(1)).toContainText('+1 ~1 \u22121 files on its branch')
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'checkouts-lens.png') })
  await popover.getByRole('radio', { name: 'Off' }).click()
  await expect(rail).toHaveCount(0)
  await expect(page.locator('.ambio-branch-overlay-mark')).toHaveCount(0)

  await popover.getByRole('button', { name: 'Show on the Floor' }).click()
  await expect.poll(() => focusRequests).toEqual([{ workspaceId: 'demo', rootId: 'root_agent' }])
})

test('a branch is reviewed as architecture, from the branch menu', async () => {
  await launch(PARALLEL)
  await page.keyboard.press('ControlOrMeta+Shift+B')
  const popover = page.getByRole('dialog', { name: 'Branches and worktrees' })
  await popover.locator('.ambio-checkout').nth(1).getByRole('button', { name: 'Review this branch' }).click()
  await expect(popover).toContainText('Review codex/retry-checkout')
  await expect(popover).toContainText('Against main · 3 files')
  const claims = popover.locator('.ambio-delta__claim')
  await expect(claims).toHaveCount(2)
  await expect(claims.first()).toContainText('Canvas Renderer now depends on Job Queue')
  if (SHOTS) {
    // Headless Electron can hand back a stale frame; a pointer move repaints.
    await page.mouse.move(700, 600)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, 'branch-review.png') })
  }
  await claims.first().getByRole('button').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ambioGraphStore: { getState: () => { selectedNodeId: string | null } } }).__ambioGraphStore.getState().selectedNodeId)).toBe('sys_canvas')
  await popover.getByRole('button', { name: '← Back' }).click()
  await expect(popover.locator('.ambio-checkout')).toHaveCount(2)
})
