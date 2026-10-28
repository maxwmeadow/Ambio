import { _electron as electron, expect, test } from '@playwright/test'
import { agentMenu } from './agentGuides'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'

test('integrated chat configures a service, streams follow-ups, keeps its agent per conversation and resumes history', async () => {
  test.setTimeout(90000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-chat-ui-'))
  const root = path.join(home, 'project'); fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.ambio'))
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const app = true\n')
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Chat fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  const requests: any[] = []
  const service = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer fixture-ui-key')
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (content: string, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'ui-test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`)
    emit('Your UI depends on ')
    const timer = setTimeout(() => { emit('Storage.'); emit('', 'stop'); res.end('data: [DONE]\n\n') }, 1500)
    res.on('close', () => clearTimeout(timer))
  })
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  const address = service.address(); if (!address || typeof address === 'string') throw new Error('No fixture service')
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  // Electron's crash reporter needs a profile under the stand-in home on Windows.
  const windowsProfile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(windowsProfile)) fs.mkdirSync(dir, { recursive: true })
  const launch = () => electron.launch({ args: ['.', ...(process.env.AMBIO_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])], env: { ...env, HOME: home, USERPROFILE: home, ...windowsProfile, AMBIO_E2E: '1', AMBIO_E2E_ROOT: root } })
  let app = await launch()
  const routeArchd = async (page: Awaited<ReturnType<typeof app.firstWindow>>) => {
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      const body = url.pathname === '/api/canvas/history' ? { messages: [], nextCursor: '', availableCount: 0 } : url.pathname === '/api/agent/presence' ? { connected: false, connections: [] } : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
  }
  try {
    let page = await app.firstWindow(); await page.setViewportSize({ width: 1400, height: 1000 })
    await routeArchd(page)
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    const destination = agentMenu(inbox)
    const intro = page.getByRole('dialog', { name: /^Before you use / })
    await intro.getByRole('button', { name: 'Got it' }).click()
    await destination.open()
    await expect(destination.group('Built into Ambio')).toHaveText(['Ambio chatSet up a model service first'])
    // Ambio chat is one more agent to pick; with no service it opens setup.
    await destination.choose('@chat')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    // A provider is chosen first; its name sits under Advanced settings.
    await settings.getByRole('button', { name: 'Add OpenAI-compatible API connection' }).click()
    await settings.getByText('Advanced settings').click()
    await settings.getByRole('textbox', { name: 'Service name' }).fill('My local test service')
    await settings.getByRole('textbox', { name: 'Service URL' }).fill(`http://127.0.0.1:${address.port}/v1`)
    await settings.getByLabel('Service API key').fill('fixture-ui-key')
    await settings.getByRole('button', { name: 'Test connection & find models' }).click()
    await expect(settings.getByRole('status')).toContainText('Connected')
    await expect(settings.getByLabel('Service model')).toHaveValue('fixture-model')
    await settings.getByRole('button', { name: 'Save service' }).click()
    // Model services are part of Settings → Agents, beside the agents Ambio runs and those in other apps.
    await expect(settings.getByRole('navigation', { name: 'Agent connection types' }).getByRole('button')).toHaveText(['Ambio chat', 'Ambio runs it', 'In another app'])
    await page.screenshot({ path: 'test-results/settings-agents.png' })
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await destination.chooseLabel('Ambio chat · My local test service · fixture-model')
    // Ambio chat works differently from the others, so it is introduced too.
    await expect(intro).toContainText('A conversation keeps the model it started with')
    await intro.getByRole('button', { name: 'Got it' }).click()
    await inbox.getByRole('button', { name: /^Request type/ }).click()
    await inbox.getByRole('menuitemradio', { name: 'Ask' }).click()
    const composer = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
    const messages = inbox.getByLabel('Messages')
    await composer.fill('Explain this architecture.')
    await inbox.getByRole('button', { name: 'Send to Ambio chat' }).click()
    await expect(messages).toContainText('Your UI depends on', { timeout: 30000 })
    await expect(messages).toContainText('Your UI depends on Storage.')
    // The conversation keeps its agent; the picker gives way to its name.
    await expect(destination.trigger).toHaveCount(0)
    await expect(inbox.locator('.ambio-inbox__delivery-fixed')).toContainText('My local test service')
    await expect(inbox.locator('.ambio-chat__status')).toHaveCount(0)
    await composer.fill('What should we change next?')
    await inbox.getByRole('button', { name: 'Send to Ambio chat' }).click()
    await expect(inbox.locator('.ambio-chat__reply')).toHaveCount(2, { timeout: 30000 })
    await expect(inbox.locator('.ambio-chat__status')).toHaveCount(0)
    expect(requests.some(request => JSON.stringify(request.messages).includes('Explain this architecture.'))).toBe(true)
    const profiles = await page.evaluate(() => window.ambio.chatProviders())
    expect(JSON.stringify(profiles)).not.toContain('fixture-ui-key')
    await page.screenshot({ path: 'test-results/integrated-agent-chat.png' })
    // A new conversation can go to any agent again.
    await inbox.getByRole('button', { name: 'New conversation' }).click()
    await destination.open()
    await expect(destination.group('Built into Ambio')).toHaveText(['Ambio chat · My local test service · fixture-model'])
    await destination.close()
    await app.close(); app = await launch(); page = await app.firstWindow()
    await routeArchd(page)
    await page.getByRole('button', { name: /^Message agent/ }).click()
    // The latest conversation opens where it was left, history included.
    await expect(page.getByLabel('Messages')).toContainText('What should we change next?', { timeout: 30000 })
    await expect(page.getByLabel('Messages')).toContainText('Your UI depends on Storage.')
    await page.getByRole('button', { name: /^Conversation:/ }).click()
    const conversationRow = page.locator('.ambio-inbox__conversation-row').filter({ hasText: 'Explain this architecture.' })
    await expect(conversationRow).toBeVisible()
    await conversationRow.getByLabel('Actions for Explain this architecture.').click()
    await conversationRow.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await conversationRow.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(conversationRow).toHaveCount(0)
    await expect(page.getByLabel('Messages')).not.toContainText('What should we change next?')
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(page.getByLabel('Messages')).not.toContainText('Explain this architecture.')
  } finally { await app.close(); service.closeAllConnections(); service.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
