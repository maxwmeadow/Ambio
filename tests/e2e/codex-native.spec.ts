import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentMenu, skipAgentGuides } from './agentGuides'

test('native Codex streams, accepts corrections, stops, resumes, asks permission and runs review', async () => {
  test.setTimeout(90000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-codex-ui-'))
  const root = path.join(home, 'project'), bin = path.join(home, 'bin')
  fs.mkdirSync(root); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.ambio'))
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Codex fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  const peer = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-app-server.cjs'), 'utf8')
  const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, peer)
  if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n${peer}`, { mode: 0o755 })
  const windowsProfile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(windowsProfile)) fs.mkdirSync(dir, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.', ...(process.env.AMBIO_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])], env: { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...windowsProfile, PATH: [bin, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')] : [])].join(path.delimiter), AMBIO_E2E: '1', AMBIO_E2E_AGENTS: '1', AMBIO_API_TOKEN: 'ambio-codex-ui-isolated-token-12345678' } })
  const setMode = (mode: string) => fs.writeFileSync(path.join(root, 'codex-fixture-mode.json'), JSON.stringify({ mode }))
  const captured = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'captured-codex.json'), 'utf8')) } catch { return {} } }
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 1000 }); await skipAgentGuides(page)
    const orders: any[] = []
    await app.evaluate(() => {
      const runtime = globalThis as any
      runtime.codexOrders = {}
      runtime.fetch = async (input: string, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/agent/permission' && init?.method === 'POST') {
          runtime.codexPermission = JSON.parse(String(init.body))
          return new Promise(resolve => { runtime.codexDecide = (decision: string) => resolve(new Response(JSON.stringify({ decision }))) })
        }
        const order = runtime.codexOrders[url.searchParams.get('messageId') ?? '']
        return new Response(JSON.stringify(order ?? { error: 'not found' }), { status: order ? 200 : 404 })
      }
    })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url()); let body: any = []
      if (url.pathname === '/api/canvas/send') {
        body = { ...route.request().postDataJSON(), status: 'queued', createdAt: Date.now() }; orders.push(body)
        await app.evaluate((_, order) => { (globalThis as any).codexOrders[order.id] = order }, body)
      }
      if (url.pathname === '/api/canvas/cancel') { const order = orders.find(item => item.id === route.request().postDataJSON().msgId); if (order) order.status = 'cancelled' }
      if (url.pathname === '/api/canvas/history') body = { messages: [...orders].reverse(), nextCursor: '', availableCount: orders.length }
      if (url.pathname === '/api/agent/presence') body = { connections: [] }
      if (url.pathname === '/api/agent/permission/decide') await app.evaluate((_, decision) => { (globalThis as any).codexDecide(decision) }, route.request().postDataJSON().decision)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    await agentMenu(inbox).choose('codex')
    const composer = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
    const send = inbox.locator('form').getByRole('button', { name: 'Start Codex CLI', exact: true })
    setMode('hold')
    await composer.fill('Read the project'); await send.click()
    await expect(composer).toBeEnabled()
    await expect(composer).toHaveAttribute('placeholder', 'Send a correction while Codex CLI works…')
    await expect(inbox.getByRole('list', { name: 'What the agent is doing' })).toContainText('Fixture is reading the project.')
    await composer.fill('Keep the public API'); await inbox.getByRole('button', { name: 'Send correction' }).click()
    await expect.poll(() => captured().corrections?.length).toBe(1)
    await expect(composer).toHaveValue('')
    expect(orders).toHaveLength(1)
    await page.screenshot({ path: 'test-results/codex-native-streaming.png' })
    await inbox.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => captured().interrupted).toBe(true)
    await expect(send).toBeVisible()
    // A follow-up resumes the provider thread and stays on the same connection.
    setMode('approval')
    await inbox.locator('.ambio-inbox__codex-options > summary').click()
    await expect(inbox.getByRole('combobox', { name: 'Codex connection' })).toBeDisabled()
    // Codex shares Claude Code's access menu; App Server offers Ask me and Full access.
    await inbox.getByRole('button', { name: 'Access: Full access' }).click()
    await expect(inbox.getByRole('menu', { name: 'What the agent may do without asking' }).getByRole('menuitemradio')).toHaveCount(2)
    await inbox.getByRole('menuitemradio', { name: 'Ask me' }).click()
    await composer.fill('Run the check'); await send.click()
    await expect.poll(() => captured().resumed).toBe(true)
    await expect.poll(async () => app.evaluate(() => !!(globalThis as any).codexPermission)).toBe(true)
    const permission = await app.evaluate(() => (globalThis as any).codexPermission)
    expect(permission.messageId).toBe(orders.at(-1).id)
    await page.evaluate(request => { (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'agent:permission', payload: { ...request, id: 'native-approval', askedAt: Date.now(), expiresAt: Date.now() + 100000 } }) }, permission)
    const card = inbox.getByRole('group', { name: 'Permission request: Codex wants to run a command' })
    await expect(card).toContainText('fixture check')
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect.poll(() => captured().decision).toBe('accept')
    await expect(inbox.locator('.ambio-inbox__turn-status').last()).toContainText('finished without replying')
    await expect(inbox).toContainText('12 input · 3 output tokens')
    setMode('complete')
    await inbox.getByRole('button', { name: 'Review changes', exact: true }).click()
    await expect(composer).toHaveValue('/review'); await send.click()
    await expect.poll(() => captured().review?.target.type).toBe('uncommittedChanges')
    await expect.poll(() => captured().prompt).toContain('Fixture native review found no issues')
    await expect(inbox.locator('.ambio-inbox__turn-status').last()).toContainText('finished without replying')
    await page.screenshot({ path: 'test-results/codex-native-review.png' })
    // The explicit compatibility route is available for a new conversation.
    await inbox.getByRole('button', { name: 'New conversation', exact: true }).click()
    await inbox.getByRole('combobox', { name: 'Codex connection' }).selectOption('exec')
    await expect(inbox.locator('.ambio-inbox__codex-options > summary')).toContainText('Exec')
    // Exec runs with full access only, so it offers no access choice.
    await expect(inbox.getByRole('button', { name: /^Access:/ })).toHaveCount(0)
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
