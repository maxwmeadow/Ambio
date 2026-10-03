import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'

// Opt in: this invokes the installed Codex CLI and uses account tokens.
test.skip(process.env.AMBIO_LIVE_HOST_TEST !== '1', 'Run with AMBIO_LIVE_HOST_TEST=1 to use a real Codex host')

for (const withSheet of [false, true]) {
  test(`desktop ${withSheet ? 'sheet' : 'project'} request reaches a live agent and returns for review`, async () => {
    test.setTimeout(180_000)
    const harness = await startHarness({ workspaceId: 'demo', projectName: 'Ambio Canvas Fixture' })
    const { ELECTRON_RUN_AS_NODE: _node, ...electronEnv } = process.env
    let app
    try {
      let sheet
      let plan
      const write = async (path, method, body) => {
        const response = await harnessFetch(`${harness.apiBase}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        expect(response.ok, await response.clone().text()).toBe(true)
        return response.json()
      }
      if (withSheet) {
        sheet = await write('/api/sheets', 'POST', { workspaceId: harness.workspaceId, name: 'Health endpoint contract', kind: 'structure' })
        const handlers = harness.snapshot.files.find(file => file.relPath === 'api/handlers.py')
        expect(handlers).toBeTruthy()
        plan = await write(`/api/sheets/${sheet.id}/planned`, 'POST', {
          workspaceId: harness.workspaceId, kind: 'file', name: 'handlers', declaredPath: 'api/handlers.py',
          parentSystemId: handlers.systemId,
          metadata: { version: 1, methods: [{ name: 'health_status', parameters: [], returnType: 'str' }] },
        })
      }
      app = await electron.launch({ args: ['.'], env: { ...electronEnv, AMBIO_E2E: '1' } })
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
        const original = new URL(route.request().url())
        const response = await route.fetch({
          url: `${harness.apiBase}${original.pathname}${original.search}`,
          headers: { ...route.request().headers(), Authorization: 'Bearer ambio-isolated-test-token-for-mcp-harness' },
        })
        await route.fulfill({ response })
      })
      await page.reload()
      // E2E mode supplies a deterministic canvas; point its handoff at the
      // isolated indexed project so the copied prompt names the real root.
      await page.evaluate(rootPath => {
        const store = window.__ambioGraphStore
        const current = store.getState().currentProject
        store.getState().setCurrentProject({ ...current, rootPath })
      }, harness.projectDir)
      await page.getByRole('button', { name: /^Message agent/ }).click()
      const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
      // The desktop keeps drafts across runs. Select this test's scope explicitly.
      const removeAttachedSheet = inbox.getByRole('button', { name: 'Remove attached sheet' })
      if (await removeAttachedSheet.isVisible()) await removeAttachedSheet.click()
      const instruction = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
      if (withSheet) {
        await instruction.press('@')
        await inbox.getByRole('dialog', { name: 'Attach a sheet' }).getByRole('option', { name: /Health endpoint contract/ }).click()
        await expect(inbox.locator('.ambio-inbox__attachment')).toContainText(sheet.name)
      }
      await instruction.fill('In api/handlers.py, add health_status() -> str returning "ok". Run python3 -m py_compile api/handlers.py. Report the changed file and check result. Leave any attached sheet active for user review. Do not edit other files.')
      await inbox.getByRole('button', { name: 'Send to inbox' }).click()
      const orderId = await inbox.locator('.ambio-inbox__work-order code').textContent()
      expect(orderId).toBeTruthy()
      await inbox.getByRole('button', { name: 'Copy handoff' }).click()
      await expect(inbox.getByRole('button', { name: 'Copied' })).toBeVisible()
      const prompt = await page.evaluate(() => navigator.clipboard.readText())
      expect(prompt).toContain(orderId)
      expect(prompt).toContain(harness.workspaceId)
      expect(prompt).toContain(harness.projectDir)
      if (withSheet) {
        const queuedHistory = await harnessFetch(`${harness.apiBase}/api/canvas/history?workspace=${harness.workspaceId}`)
        expect((await queuedHistory.json()).messages.find(message => message.id === orderId).sheetId).toBe(sheet.id)
      }

      const configs = [
        `mcp_servers.ambio.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.ambio.args=${JSON.stringify([fileURLToPath(new URL('../../mcp/ambio-mcp.ts', import.meta.url)), '--ambio-host=codex'])}`,
        `mcp_servers.ambio.env.AMBIO_API_URL=${JSON.stringify(harness.apiBase)}`,
        `mcp_servers.ambio.env.AMBIO_API_TOKEN=${JSON.stringify('ambio-isolated-test-token-for-mcp-harness')}`,
        `mcp_servers.ambio.env.AMBIO_ACTIVE_PROJECT=${JSON.stringify(harness.activeProjectPath)}`,
      ]
      const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '-C', harness.projectDir, '--approve-for-me', ...configs.flatMap(config => ['-c', config]), prompt]
      const agent = spawn(process.env.AMBIO_CODEX_BIN || 'codex', args, { cwd: harness.projectDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let agentOutput = ''
      agent.stderr.on('data', chunk => { agentOutput += String(chunk) })
      agent.stdout.resume()
      const timeout = setTimeout(() => agent.kill(), 120_000)
      const exit = await new Promise((resolve, reject) => { agent.on('error', reject); agent.on('close', resolve) })
      clearTimeout(timeout)
      expect(exit, agentOutput.slice(-3000)).toBe(0)
      const presenceResponse = await harnessFetch(`${harness.apiBase}/api/agent/presence?workspace=${harness.workspaceId}`)
      const presence = await presenceResponse.json()
      expect(presence.connections.some(connection => connection.hostId === 'codex' && connection.lastToolAt > 0)).toBe(true)

      await expect(inbox.locator('.ambio-inbox__reply').getByText(/health_status/)).toBeVisible({ timeout: 15_000 })
      expect(readFileSync(`${harness.projectDir}/api/handlers.py`, 'utf8')).toContain('def health_status(')
      expect(execFileSync('python3', ['-c', 'from handlers import health_status; print(health_status())'], { cwd: `${harness.projectDir}/api`, encoding: 'utf8' }).trim()).toBe('ok')
      await expect(inbox.getByRole('button', { name: /Review result/ })).toBeVisible()
      if (withSheet) {
        // A later user edit must not replace the contract this agent received.
        await write(`/api/sheets/${sheet.id}/planned`, 'POST', { ...plan, metadata: { version: 1, methods: [{ name: 'health_status', parameters: [], returnType: 'int' }] } })
        const sent = await harnessFetch(`${harness.apiBase}/api/canvas/snapshot-comparison?workspace=${harness.workspaceId}&messageId=${orderId}`)
        const comparison = await sent.json()
        expect(comparison.equivalent, JSON.stringify(comparison)).toBe(true)
        expect(comparison.currentSheetRevision).toBeGreaterThan(comparison.revision)
        const current = await harnessFetch(`${harness.apiBase}/api/sheets/${sheet.id}/compare?workspace=${harness.workspaceId}`)
        expect((await current.json()).equivalent).toBe(false)
        await expect(inbox.locator('.ambio-inbox__bottom .ambio-inbox__comparison').getByRole('button', { name: /[1-9]\d* structural differences?/ })).toBeVisible({ timeout: 15_000 })
      }
      await inbox.getByRole('button', { name: /Review result/ }).click()
      await expect(inbox.getByRole('button', { name: 'Accept result' })).toBeVisible()
      await expect(inbox.getByText('Work sessions')).toBeVisible()
      const beforeReviewResponse = await harnessFetch(`${harness.apiBase}/api/canvas/history?workspace=${harness.workspaceId}`)
      const beforeReview = (await beforeReviewResponse.json()).messages.find(message => message.id === orderId)
      expect(beforeReview.sessions?.length).toBeGreaterThan(0)
      expect(beforeReview.reply?.result?.changedFiles).toContain('api/handlers.py')
      expect(beforeReview.reply?.result?.checks?.length).toBeGreaterThan(0)
      if (withSheet) {
        const sentCheck = inbox.getByRole('button', { name: /Sent structure matches the live architecture/ })
        await expect(sentCheck).toBeVisible()
        await sentCheck.scrollIntoViewIfNeeded()
      }
      await page.screenshot({ path: `test-results/live-host-${withSheet ? 'sheet' : 'project'}-review.png` })
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
}
