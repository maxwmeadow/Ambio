import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentMenu, setAgentAccess, skipAgentGuides } from './agentGuides'

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
          return new Promise(resolve => { runtime.codexDecide = (answer: object) => resolve(new Response(JSON.stringify(answer))) })
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
      if (url.pathname === '/api/agent/permission/decide') await app.evaluate((_, answer) => { (globalThis as any).codexDecide(answer) }, route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    await agentMenu(inbox).choose('codex')
    // A model's reasoning efforts come from Codex's own list; the choice rides on the turn.
    await inbox.getByRole('button', { name: /^Model: / }).click()
    await inbox.getByRole('menuitemradio', { name: 'Fixture model', exact: true }).click()
    await expect(inbox.getByRole('menuitemradio', { name: 'Thinking: Medium' })).toHaveAttribute('aria-checked', 'true')
    await inbox.getByRole('menuitemradio', { name: 'Thinking: High' }).click()
    await expect(inbox.getByRole('button', { name: 'Model: Fixture model, High thinking' })).toBeVisible()
    const composer = inbox.getByRole('textbox', { name: 'Instruction for your agent' })
    const send = inbox.locator('form').getByRole('button', { name: 'Start Codex CLI', exact: true })
    setMode('hold')
    await composer.fill('Read the project'); await send.click()
    await expect(composer).toBeEnabled()
    await expect(composer).toHaveAttribute('placeholder', 'Send a correction while Codex CLI works…')
    await expect(inbox.getByRole('list', { name: 'What the agent is doing' })).toContainText('Fixture is reading the project.')
    await composer.fill('Keep the public API'); await inbox.getByRole('button', { name: 'Send correction' }).click()
    await expect.poll(() => captured().corrections?.length).toBe(1)
    expect(captured().effort).toBe('high')
    await expect(composer).toHaveValue('')
    expect(orders).toHaveLength(1)
    await page.screenshot({ path: 'test-results/codex-native-streaming.png' })
    await inbox.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => captured().interrupted).toBe(true)
    await expect(send).toBeVisible()
    // Host-list IPC returned before discovery. Reopening refreshes from its cache.
    await expect.poll(async () => page.evaluate(async () => (await window.ambio.listDeliveryHosts()).find(host => host.id === 'codex')?.access)).toContain('auto')
    await inbox.getByRole('button', { name: 'Close agent inbox' }).click()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    // A follow-up resumes the provider thread and stays on the same connection.
    setMode('approval')
    // The message box offers no Codex-only options.
    await expect(inbox.locator('.ambio-inbox__codex-options')).toHaveCount(0)
    // The qualified fixture version adds Auto to the shared access levels.
    expect(await setAgentAccess(inbox, 'Codex CLI', 'Ask me')).toEqual(['ask', 'auto', 'full'])
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
    await expect(inbox.locator('.ambio-turn').last()).toContainText('finished without replying')
    await expect(inbox).toContainText('12 input, 3 output tokens')
    setMode('complete')
    // /review runs Codex's native reviewer on the current changes.
    await composer.fill('/review'); await send.click()
    await expect.poll(() => captured().review?.target.type).toBe('uncommittedChanges')
    await expect.poll(() => captured().prompt).toContain('Fixture native review found no issues')
    await expect(inbox.locator('.ambio-turn').last()).toContainText('finished without replying')
    await page.screenshot({ path: 'test-results/codex-native-review.png' })
    // Auto uses the native reviewer, retaining an Ask's read-only sandbox.
    await setAgentAccess(inbox, 'Codex CLI', 'Auto')
    await inbox.getByRole('button', { name: /^Request type/ }).click()
    await inbox.getByRole('menuitemradio', { name: 'Ask' }).click()
    await composer.fill('Use automatic review for this check'); await send.click()
    await expect.poll(() => captured().setup.approvalsReviewer).toBe('auto_review')
    expect(captured().setup.sandbox).toBe('read-only')
    expect(captured().setup.approvalPolicy).toBe('on-request')
    await expect(inbox.locator('.ambio-turn').last().locator('.ambio-turn__tool', { hasText: 'Auto review' })).toContainText('approved')
    await expect(inbox.locator('.ambio-turn').last()).toContainText('finished without replying')
    setMode('subagent')
    await composer.fill('Inspect using a child agent'); await send.click()
    const subagentCall = inbox.locator('.ambio-turn').last().locator('.ambio-turn__tool', { hasText: 'spawnAgent → Reviewer' })
    await expect(subagentCall.locator('.ambio-turn__subagent')).toHaveText('Main agent')
    await expect(subagentCall).toContainText('explorer')
    await expect(inbox.locator('.ambio-turn').last()).toContainText('finished without replying')
    await page.screenshot({ path: 'test-results/codex-native-auto-subagent.png' })
    // The steps between messages are one line; opened, every step shows whole.
    const steps = inbox.locator('.ambio-turn').last().locator('.ambio-turn__steps-toggle').last()
    await expect(steps).toHaveText('Ran a command, used a tool and a subagent')
    await steps.click()
    await expect(inbox.locator('.ambio-turn').last().locator('.ambio-turn__step-list').last()).toBeVisible()
    await inbox.locator('.ambio-turn').last().screenshot({ path: 'test-results/codex-native-steps.png' })
    // Structured questions use the shared card for choices and the user's own words.
    setMode('question')
    await composer.fill('Ask me which color to use'); await send.click()
    await expect.poll(async () => app.evaluate(() => (globalThis as any).codexPermission?.kind)).toBe('question')
    const question = await app.evaluate(() => (globalThis as any).codexPermission)
    expect(question.waitMs).toBe(600000)
    expect(question.messageId).toBe(orders.at(-1).id)
    await page.evaluate(request => { (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'agent:permission', payload: { ...request, id: 'native-question', askedAt: Date.now(), expiresAt: Date.now() + 600000 } }) }, question)
    const questionCard = inbox.getByRole('form', { name: 'Question: Which color should the fixture use?' })
    await questionCard.getByRole('radio', { name: /Blue/ }).check()
    await questionCard.getByRole('textbox', { name: 'Answer: Why this color?' }).fill('It suits the fixture, and stays readable.')
    await page.screenshot({ path: 'test-results/codex-native-question.png' })
    await questionCard.getByRole('button', { name: 'Answer', exact: true }).click()
    await expect.poll(() => captured().questionReply).toEqual({ answers: { color: { answers: ['Blue'] }, reason: { answers: ['It suits the fixture, and stays readable.'] } } })
    await expect(inbox.locator('.ambio-turn').last()).toContainText('finished without replying')
    // Declining is a protocol refusal, with no invented successful answer.
    const beforeDecline = orders.length
    await composer.fill('Ask again so I can decline'); await send.click()
    await expect.poll(() => orders.length).toBe(beforeDecline + 1)
    await expect.poll(async () => app.evaluate(() => (globalThis as any).codexPermission?.messageId)).toBe(orders.at(-1).id)
    const declinedQuestion = await app.evaluate(() => (globalThis as any).codexPermission)
    await page.evaluate(request => { (window as any).__ambioGraphStore.getState().applyDbPatch({ type: 'agent:permission', payload: { ...request, id: 'declined-question', askedAt: Date.now(), expiresAt: Date.now() + 600000 } }) }, declinedQuestion)
    await inbox.getByRole('button', { name: 'Don’t answer' }).click()
    await expect.poll(() => captured().questionReply?.message).toContain('declined')
    await expect(inbox.locator('.ambio-turn').last()).toContainText('finished without replying')
    // An installed version losing qualification must not widen a saved Auto choice.
    await inbox.getByRole('button', { name: 'New conversation', exact: true }).click()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agent:delivery-hosts')
      ipcMain.handle('agent:delivery-hosts', () => [{ id: 'codex', label: 'Codex CLI', route: 'run', available: true, detail: '', access: ['ask', 'full'] }])
    })
    // Reload models the app reopening after its installed CLI was replaced.
    await page.reload()
    if (!(await inbox.isVisible())) await page.getByRole('button', { name: /^Message agent/ }).click()
    // Its guide asks again, saying why, and nothing is sent until a level is chosen.
    const intro = page.getByRole('dialog', { name: 'Before you use Codex CLI' })
    await expect(intro).toContainText('Auto is not available in this version of Codex CLI')
    const levels = intro.getByRole('group', { name: 'What Codex CLI may do without asking' })
    await expect(levels.getByRole('radio')).toHaveCount(2)
    await expect(levels.getByRole('radio', { checked: true })).toHaveCount(0)
    await expect(intro.getByRole('button', { name: 'Got it' })).toBeDisabled()
    await levels.getByRole('radio', { name: /^Ask me/ }).check()
    await intro.getByRole('button', { name: 'Got it' }).click()
    await expect(intro).toBeHidden()
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
