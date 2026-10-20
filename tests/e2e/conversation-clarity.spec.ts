import { _electron as electron, expect, test } from '@playwright/test'
import { skipAgentGuides } from './agentGuides'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('conversation attention, notification targeting, rename and deletion persist without changing a sheet', async () => {
  test.setTimeout(60000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-clarity-ui-'))
  const profile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(profile)) fs.mkdirSync(dir, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home, ...profile, AMBIO_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await skipAgentGuides(page)
    await page.setViewportSize({ width: 1440, height: 940 })
    const now = Date.now()
    let messages = [
      { id: 'clarity-first', threadId: 'clarity-first', note: 'Explain formulas', status: 'answered', createdAt: now - 3000, reply: { body: 'Formula execution uses shared dispatch.', agent: 'Codex', createdAt: now - 2500 } },
      { id: 'clarity-second', threadId: 'clarity-second', note: 'Explain workflows', status: 'answered', createdAt: now - 2000, reply: { body: 'Workflow execution uses shared dispatch.', agent: 'Codex', createdAt: now - 1500 } },
      { id: 'clarity-running', threadId: 'clarity-running', note: 'Inspect shared dispatch', status: 'queued', createdAt: now - 1000 },
    ].map(message => ({ workspaceId: 'demo', mode: 'ask', sheetId: null, selection: '[]', changeSummary: '', deliveryMode: 'addressed', ...message }))
    const deleted: unknown[] = []
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      let body: unknown = []
      if (url.pathname === '/api/canvas/history') body = { messages, nextCursor: '', availableCount: 1 }
      if (url.pathname === '/api/canvas/conversation') {
        expect(route.request().method()).toBe('DELETE')
        const request = route.request().postDataJSON()
        deleted.push(request)
        messages = messages.filter(message => message.threadId !== request.threadId)
        body = { deleted: true }
      }
      await route.fulfill({ json: body })
    })
    await page.evaluate(() => {
      const key = 'ambio:conversation-presentation'
      const preferences = JSON.parse(localStorage.getItem(key) ?? '{}')
      for (const id of ['clarity-first', 'clarity-second', 'clarity-running']) delete preferences[JSON.stringify(['demo', id])]
      localStorage.setItem(key, JSON.stringify(preferences))
    })
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    await panel.getByRole('button', { name: /^Conversation:/ }).click()
    const firstRow = panel.locator('.ambio-inbox__conversation-row').filter({ hasText: 'Explain formulas' })
    await expect(firstRow.getByText('New reply', { exact: true })).toBeVisible()
    await expect(firstRow).not.toContainText('turn')
    await panel.getByLabel('Actions for Inspect shared dispatch').click()
    await expect(panel.getByRole('button', { name: 'Delete conversation', exact: true })).toBeDisabled()
    await panel.getByLabel('Actions for Inspect shared dispatch').click()
    await firstRow.getByLabel('Actions for Explain formulas').click()
    await firstRow.getByRole('button', { name: 'Rename', exact: true }).click()
    await panel.getByLabel('Conversation name').fill('Formula architecture')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await panel.getByRole('menuitemradio', { name: /Formula architecture/ }).click()
    await expect(panel.getByText('Formula execution uses shared dispatch.')).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await panel.getByRole('button', { name: /^Conversation:/ }).click()
    const renamed = panel.locator('.ambio-inbox__conversation-row').filter({ hasText: 'Formula architecture' })
    await expect(renamed.getByText('New reply', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'test-results/conversation-clarity.png' })
    await panel.getByRole('button', { name: 'Close agent inbox' }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:open-conversation', { workspaceId: 'demo', threadId: 'clarity-first' }))
    await expect(panel.getByRole('button', { name: 'Conversation: Formula architecture', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: /^Conversation:/ }).click()
    await renamed.getByLabel('Actions for Formula architecture').click()
    await renamed.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await renamed.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(renamed).toHaveCount(0)
    expect(deleted).toEqual([{ workspaceId: 'demo', threadId: 'clarity-first' }])
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await panel.getByRole('button', { name: /^Conversation:/ }).click()
    await expect(panel.getByRole('menuitemradio', { name: /Formula architecture/ })).toHaveCount(0)

    // With no explicit selection, deleting the default latest thread must not
    // briefly open the next thread and consume its unread reply.
    messages = [
      { ...messages[0], id: 'clarity-delete-latest', threadId: 'clarity-delete-latest', note: 'Delete this QA chat', status: 'answered', createdAt: now + 100, reply: { body: 'Disposable reply.', agent: 'Codex', createdAt: now + 101 } },
      { ...messages[0], id: 'clarity-keep-unread', threadId: 'clarity-keep-unread', note: 'Keep this reply unread', status: 'answered', createdAt: now + 50, reply: { body: 'Unread reply.', agent: 'Codex', createdAt: now + 51 } },
    ]
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(panel.getByText('Disposable reply.', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: /^Conversation:/ }).click()
    const retained = panel.locator('.ambio-inbox__conversation-row').filter({ hasText: 'Keep this reply unread' })
    await expect(retained.getByText('New reply', { exact: true })).toBeVisible()
    const disposable = panel.locator('.ambio-inbox__conversation-row').filter({ hasText: 'Delete this QA chat' })
    await disposable.getByLabel('Actions for Delete this QA chat').click()
    await disposable.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await disposable.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(disposable).toHaveCount(0)
    await expect(retained.getByText('New reply', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Conversation: New conversation', exact: true })).toBeVisible()
  } finally { await app.close() }
})
