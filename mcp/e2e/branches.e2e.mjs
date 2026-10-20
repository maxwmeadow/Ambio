import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { startHarness } from './mcpHarness.mjs'

// An agent in one worktree asks what the other branches are doing before it
// starts, and reviews a branch's architecture (docs/GIT_AND_PROJECT_SHAPES.md
// stage 3: get_architecture scope "branches").

function write(root, relPath, body) {
  const path = join(root, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim()

test('an agent reads every branch and reviews one', { timeout: 90000 }, async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ambio-mcp-branches-'))
  const worktreeParent = mkdtempSync(join(tmpdir(), 'ambio-mcp-branches-wt-'))
  write(projectDir, 'src/api/api.ts', "import { store } from '../storage/store'\nexport const api = () => store()\n")
  write(projectDir, 'src/api/routes.ts', "import { api } from './api'\nexport const routes = [api]\n")
  write(projectDir, 'src/storage/store.ts', 'export const store = () => 1\n')
  write(projectDir, 'src/storage/pool.ts', "import { store } from './store'\nexport const pool = [store]\n")
  write(projectDir, 'src/email/email.ts', 'export const send = () => 2\n')
  write(projectDir, 'src/email/templates.ts', "import { send } from './email'\nexport const welcome = () => send()\n")
  git(projectDir, 'init', '-b', 'main')
  git(projectDir, 'config', 'user.email', 'ambio-test@example.com')
  git(projectDir, 'config', 'user.name', 'Ambio Test')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'base')
  const agent = join(worktreeParent, 'agent')
  git(projectDir, 'worktree', 'add', '-b', 'agent/notify', agent)
  write(agent, 'src/api/api.ts', "import { send } from '../email/email'\nexport const api = () => send()\n")
  write(agent, 'src/api/notify.ts', "import { api } from './api'\nexport const notify = () => api()\n")

  const harness = await startHarness({ projectDir, minFiles: 6 })
  try {
    const listed = await harness.client.callTool('get_architecture', { scope: 'branches' })
    assert.equal(listed.isError, false, listed.text)
    const branches = listed.payload.branches
    assert.deepEqual(branches.map(branch => branch.branch).sort(), ['agent/notify', 'main'])
    const main = branches.find(branch => branch.branch === 'main')
    assert.equal(main.onTheMap, true)
    assert.equal(main.you, true)
    const other = branches.find(branch => branch.branch === 'agent/notify')
    const changing = Object.values(other.changing ?? {})
    assert.equal(changing.reduce((sum, counts) => sum + counts.added + counts.changed + counts.deleted, 0), 2)

    const reviewed = await harness.client.callTool('get_architecture', { scope: 'branches', id: 'agent/notify' })
    assert.equal(reviewed.isError, false, reviewed.text)
    assert.equal(reviewed.payload.review.against, 'main')
    assert.equal(reviewed.payload.review.files, 2)
    assert.ok(reviewed.payload.review.claims.length > 0, JSON.stringify(reviewed.payload.review))

    const missing = await harness.client.callTool('get_architecture', { scope: 'branches', id: 'nope' })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /agent\/notify/)
  } finally {
    harness.stop()
    for (const dir of [projectDir, worktreeParent]) rmSync(dir, { recursive: true, force: true })
  }
})
