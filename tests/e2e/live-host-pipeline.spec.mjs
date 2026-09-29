import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'

// Opt in: this invokes the installed Codex CLI and uses account tokens.
test.skip(process.env.AXIOM_LIVE_HOST_TEST !== '1', 'Run with AXIOM_LIVE_HOST_TEST=1 to use a real Codex host')

test('desktop send reaches a live agent and returns for review', async () => {
  test.setTimeout(180_000)
  const harness = await startHarness({ workspaceId: 'demo', projectName: 'Axiom Canvas Fixture' })
  const { ELECTRON_RUN_AS_NODE: _node, ...electronEnv } = process.env
  let app
  try {
    app = await electron.launch({ args: ['.'], env: { ...electronEnv, AXIOM_E2E: '1' } })
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const original = new URL(route.request().url())
      const response = await route.fetch({
        url: `${harness.apiBase}${original.pathname}${original.search}`,
        headers: { ...route.request().headers(), Authorization: 'Bearer axiom-isolated-test-token-for-mcp-harness' },
      })
      await route.fulfill({ response })
    })
    await page.reload()
    // E2E mode supplies a deterministic canvas; point its handoff at the
    // isolated indexed project so the copied prompt names the real root.
    await page.evaluate(rootPath => {
      const store = window.__axiomGraphStore
      const current = store.getState().currentProject
      store.getState().setCurrentProject({ ...current, rootPath })
    }, harness.projectDir)
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    const instruction = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
    await instruction.fill('In api/handlers.py, add health_status() returning "ok". Run python3 -m py_compile api/handlers.py. Report the changed file and check result. Do not edit other files.')
    await inbox.getByRole('button', { name: 'Send to inbox' }).click()
    const orderId = await inbox.locator('.axiom-inbox__work-order code').textContent()
    expect(orderId).toBeTruthy()
    await inbox.getByRole('button', { name: 'Copy handoff' }).click()
    await expect(inbox.getByRole('button', { name: 'Copied' })).toBeVisible()
    const prompt = await page.evaluate(() => navigator.clipboard.readText())
    expect(prompt).toContain(orderId)
    expect(prompt).toContain(harness.workspaceId)
    expect(prompt).toContain(harness.projectDir)

    const configs = [
      `mcp_servers.axiom.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.axiom.args=${JSON.stringify([fileURLToPath(new URL('../../mcp/axiom-mcp.ts', import.meta.url)), '--axiom-host=codex'])}`,
      `mcp_servers.axiom.env.AXIOM_API_URL=${JSON.stringify(harness.apiBase)}`,
      `mcp_servers.axiom.env.AXIOM_API_TOKEN=${JSON.stringify('axiom-isolated-test-token-for-mcp-harness')}`,
      `mcp_servers.axiom.env.AXIOM_ACTIVE_PROJECT=${JSON.stringify(harness.activeProjectPath)}`,
    ]
    const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '-C', harness.projectDir, '--approve-for-me', ...configs.flatMap(config => ['-c', config]), prompt]
    const agent = spawn(process.env.AXIOM_CODEX_BIN || 'codex', args, { cwd: harness.projectDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let agentOutput = ''
    agent.stderr.on('data', chunk => { agentOutput += String(chunk) })
    agent.stdout.resume()
    const timeout = setTimeout(() => agent.kill(), 120_000)
    const exit = await new Promise((resolve, reject) => { agent.on('error', reject); agent.on('close', resolve) })
    clearTimeout(timeout)
    expect(exit, agentOutput.slice(-3000)).toBe(0)

    await expect(inbox.locator('.axiom-inbox__reply').getByText(/health_status/)).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(`${harness.projectDir}/api/handlers.py`, 'utf8')).toContain('def health_status(')
    await expect(inbox.getByRole('button', { name: /Review result/ })).toBeVisible()
    await inbox.getByRole('button', { name: /Review result/ }).click()
    await expect(inbox.getByRole('button', { name: 'Accept result' })).toBeVisible()
    await expect(inbox.getByText('Work sessions')).toBeVisible()
    const beforeReviewResponse = await harnessFetch(`${harness.apiBase}/api/canvas/history?workspace=${harness.workspaceId}`)
    const beforeReview = (await beforeReviewResponse.json()).messages.find(message => message.id === orderId)
    expect(beforeReview.sessions?.length).toBeGreaterThan(0)
    expect(beforeReview.reply?.result?.changedFiles).toContain('api/handlers.py')
    expect(beforeReview.reply?.result?.checks?.length).toBeGreaterThan(0)
    await page.screenshot({ path: 'test-results/live-host-desktop-review.png' })
    await inbox.getByRole('button', { name: 'Accept result' }).click()
    await expect(inbox.getByText('Accepted', { exact: true }).first()).toBeVisible()
    const historyResponse = await harnessFetch(`${harness.apiBase}/api/canvas/history?workspace=${harness.workspaceId}`)
    const order = (await historyResponse.json()).messages.find((message) => message.id === orderId)
    expect(order.status).toBe('answered')
    expect(order.review.decision).toBe('accepted')
  } finally {
    try { await app?.close() } finally { harness.stop() }
  }
})
