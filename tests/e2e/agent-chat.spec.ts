import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'

test('integrated chat configures a service, streams follow-ups, preserves external choices and resumes history', async () => {
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
  const launch = () => electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home, AMBIO_E2E: '1', AMBIO_E2E_ROOT: root } })
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
    await expect(inbox.getByRole('combobox', { name: 'Work-order destination' }).locator('option')).toHaveCount(11)
    await inbox.getByRole('tab', { name: 'Work orders' }).focus()
    await inbox.getByRole('tab', { name: 'Work orders' }).press('ArrowRight')
    await expect(inbox.getByRole('tab', { name: 'Chat in Ambio' })).toHaveAttribute('aria-selected', 'true')
    await inbox.getByRole('button', { name: 'Connect a model service' }).click()
    await inbox.getByRole('combobox', { name: 'Model provider' }).selectOption('compatible')
    await inbox.getByRole('textbox', { name: 'Service name' }).fill('My local test service')
    await inbox.getByRole('textbox', { name: 'Service URL' }).fill(`http://127.0.0.1:${address.port}/v1`)
    await inbox.getByLabel('Service API key').fill('fixture-ui-key')
    await inbox.getByRole('button', { name: 'Test connection & find models' }).click()
    await expect(inbox.getByRole('status')).toContainText('Connected')
    await expect(inbox.getByLabel('Service model')).toHaveValue('fixture-model')
    await inbox.getByRole('button', { name: 'Save service' }).click()
    await inbox.getByRole('textbox', { name: 'Message integrated agent' }).fill('Explain this architecture.')
    await inbox.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(inbox.getByLabel('Conversation messages')).toContainText('Your UI depends on', { timeout: 30000 })
    await expect(inbox.getByLabel('Conversation messages')).toContainText('Your UI depends on Storage.')
    await expect(inbox.getByRole('status')).toContainText('Ready for your next message')
    await inbox.getByRole('textbox', { name: 'Message integrated agent' }).fill('What should we change next?')
    await inbox.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(inbox.locator('.ambio-chat__message--assistant')).toHaveCount(2, { timeout: 30000 })
    await expect(inbox.getByRole('status')).toContainText('Ready for your next message')
    expect(requests.some(request => JSON.stringify(request.messages).includes('Explain this architecture.'))).toBe(true)
    const profiles = await page.evaluate(() => window.ambio.chatProviders())
    expect(JSON.stringify(profiles)).not.toContain('fixture-ui-key')
    expect(await page.evaluate(() => localStorage.getItem('ambio:chat-draft:demo'))).toBe('')
    await page.screenshot({ path: 'test-results/integrated-agent-chat.png' })
    await inbox.getByRole('tab', { name: 'Work orders' }).click()
    await expect(inbox.getByRole('combobox', { name: 'Work-order destination' }).locator('option')).toHaveCount(11)
    await app.close(); app = await launch(); page = await app.firstWindow()
    await routeArchd(page)
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await page.getByRole('tab', { name: 'Chat in Ambio' }).click()
    await expect(page.getByLabel('Conversation messages')).toContainText('What should we change next?', { timeout: 30000 })
    await expect(page.getByLabel('Conversation messages')).toContainText('Your UI depends on Storage.')
  } finally { await app.close(); service.closeAllConnections(); service.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
