import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentMenu, agentSetup, setAgentAccess, skipAgentGuides } from './agentGuides'

test('Antigravity uses its reported model route, asks permission and finishes steered work', async () => {
  test.setTimeout(120000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-agy-ui-'))
  const root = path.join(home, 'project'), capture = path.join(home, 'capture.jsonl')
  fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.ambio'))
  const fixture = path.resolve(__dirname, 'fixtures', 'antigravity-agent.cjs')
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Antigravity fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  fs.writeFileSync(path.join(home, '.ambio', 'agent-executable-overrides.json'), JSON.stringify({ 'antigravity-cli': fixture }))
  const config = path.join(home, '.gemini', 'config')
  fs.mkdirSync(config, { recursive: true }); fs.writeFileSync(path.join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: { ambio: { command: 'fixture' } } }))
  const windowsProfile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(windowsProfile)) fs.mkdirSync(dir, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...windowsProfile, AMBIO_E2E: '1', AMBIO_E2E_AGENTS: '1', AMBIO_AGY_CAPTURE: capture, AMBIO_API_TOKEN: 'ambio-antigravity-isolated-ui-token-123456' } })
  const captured = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1400, height: 1000 }); await skipAgentGuides(page)
    const orders: any[] = []
    await app.evaluate(() => {
      const runtime = globalThis as any
      runtime.agyOrders = {}; runtime.agyPermission = null
      runtime.fetch = async (input: string, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/agent/permission') {
          const body = JSON.parse(String(init?.body))
          runtime.agyPermission = { ...body, id: 'permission-1', askedAt: Date.now(), expiresAt: Date.now() + 110000 }
          return new Promise(resolve => { runtime.agyDecide = (decision: string) => { runtime.agyPermission = null; resolve(new Response(JSON.stringify({ decision, answered: true }), { status: 200 })) } })
        }
        const found = runtime.agyOrders[url.searchParams.get('messageId') ?? '']
        return new Response(JSON.stringify(found ?? { error: 'not found' }), { status: found ? 200 : 404 })
      }
    })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url()); let body: any = []
      if (url.pathname === '/api/canvas/send') {
        const sent = route.request().postDataJSON()
        body = { ...sent, workspaceId: 'demo', status: 'queued', deliveryMode: 'addressed', createdAt: Date.now() }; orders.push(body)
        await app.evaluate((_, order) => { (globalThis as any).agyOrders[order.id] = order }, body)
      }
      if (url.pathname === '/api/canvas/history') body = { messages: [...orders].reverse(), nextCursor: '' }
      if (url.pathname === '/api/agent/presence') body = { connections: [] }
      if (url.pathname === '/api/agent/permission') body = { requests: await app.evaluate(() => { const permission = (globalThis as any).agyPermission; return permission ? [permission] : [] }) }
      if (url.pathname === '/api/agent/permission/decide') await app.evaluate((_, decision) => (globalThis as any).agyDecide(decision), route.request().postDataJSON().decision)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    await agentMenu(panel).choose('antigravity-cli')
    const setup = agentSetup(panel)
    await setup.chooseModel('Gemini Fixture')
    // The thinking level is chosen in the same control, back on its rows.
    await setup.chooseThinking('Low')
    await expect(setup.trigger).toHaveAccessibleName('Client and model: Antigravity CLI, Gemini Fixture, Low thinking')
    // The ACP connection offers the shared access levels; Ask me sends requests to the conversation.
    expect(await setAgentAccess(panel, 'Antigravity CLI', 'Ask me')).toEqual(['ask', 'full'])
    // The message box says nothing about the connection or its access.
    await expect(panel.locator('.ambio-inbox__transport')).toHaveCount(0)
    // An attached image goes to Antigravity with its turn: it says it takes images.
    const shot = path.join(home, 'shot.png')
    fs.writeFileSync(shot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwqZYRwAU7QG/i/m3WkAAAAASUVORK5CYII=', 'base64'))
    await app.evaluate(({ dialog }, file) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, shot)
    await panel.getByRole('button', { name: 'Attach context' }).click()
    await panel.getByRole('dialog', { name: 'Attach context' }).getByRole('button', { name: 'Files…' }).click()
    await expect(panel.locator('.ambio-inbox__compose .ambio-inbox__chip', { hasText: 'shot.png' })).toHaveCount(1)
    const textbox = panel.getByRole('textbox', { name: 'Instruction for your agent' })
    // The / menu: Ambio's own commands, then Antigravity's, as it advertises them.
    await textbox.fill('/')
    const commands = panel.getByRole('listbox', { name: 'Commands' })
    await expect(commands.locator('.ambio-inbox__picker-label')).toHaveText(['Ambio', 'Antigravity CLI'])
    await expect(commands.getByRole('option', { name: /\/plan/ })).toBeVisible()
    await page.screenshot({ path: 'test-results/slash-commands.png' })
    // Ambio's commands act at once and are not sent.
    await textbox.fill('/as')
    await textbox.press('Enter')
    await expect(textbox).toHaveValue('')
    await expect(panel.locator('.ambio-inbox__mode-button')).toContainText('Ask')
    await textbox.fill('/build')
    await textbox.press('Enter')
    await expect(panel.locator('.ambio-inbox__mode-button')).toContainText('Build')
    // The agent's command goes with the message and runs before the request.
    await textbox.fill('/pl')
    await textbox.press('Enter')
    await expect(textbox).toHaveValue('/plan ')
    await textbox.pressSequentially('Fix the fixture')
    await panel.getByRole('button', { name: 'Start Antigravity CLI', exact: true }).click()
    await expect.poll(() => captured().some(item => item.transport === 'acp')).toBe(true)
    await expect.poll(() => captured().find(item => item.blocks)?.blocks).toEqual(['text', 'image'])
    // The command ran first, then Ambio's request in the same session.
    const order = captured().filter(item => item.command || item.blocks).map(item => item.command ?? 'request')
    expect(order).toEqual(['/plan Fix the fixture', 'request'])
    await expect.poll(() => app.evaluate(() => !!(globalThis as any).agyPermission)).toBe(true)
    expect(await app.evaluate(() => (globalThis as any).agyPermission.messageId)).toBe(orders[0].id)
    expect(fs.existsSync(path.join(root, 'fixture.txt'))).toBe(false)
    // Reload restores the daemon's pending desk even without a WebSocket.
    await page.reload()
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await panel.getByRole('group', { name: 'Permission request: Edit fixture.txt' }).getByRole('button', { name: 'Allow', exact: true }).click()
    await expect.poll(() => fs.existsSync(path.join(root, 'fixture.txt'))).toBe(true)
    // The tool call's update replaced it in place, with its change behind one expandable diff.
    const activity = panel.getByRole('list', { name: 'What the agent is doing' })
    // Steps between the agent's messages fold into one line each; opened, every step shows in full.
    for (const toggle of await activity.locator('.ambio-turn__steps-toggle[aria-expanded="false"]').all()) await toggle.click()
    const edit = activity.locator('.ambio-turn__step-list > li').filter({ hasText: 'fixture.txt' })
    await expect(edit).toHaveCount(1)
    // A finished step says nothing about being done; it opens to its change.
    await expect(edit).not.toContainText('done')
    await edit.getByRole('button', { expanded: false }).click()
    await expect(edit.locator('pre')).toContainText('+approved')
    // agy's other steps: each said once, Ambio's call by name and opening to what it asked, the failed read marked.
    // A file reads by its name, its folder after it; the row wraps rather than clipping.
    const skill = activity.locator('.ambio-turn__step-list > li').filter({ has: page.locator('.ambio-turn__tool-name', { hasText: /^SKILL\.md$/ }) })
    await expect(skill).toHaveCount(1)
    await expect(skill.locator('.ambio-turn__target')).toHaveText('~/.gemini/config/skills/ambio-inbox')
    expect(await skill.evaluate(row => getComputedStyle(row).whiteSpace)).toBe('normal')
    const architecture = activity.locator('.ambio-turn__step-list > li').filter({ hasText: 'Get architecture' })
    await expect(architecture).toContainText('overview')
    await expect(activity.locator('.ambio-turn__state[data-failed]')).toHaveText('failed')
    await expect(activity).not.toContainText('·')
    await architecture.getByRole('button').click()
    await expect(architecture.locator('pre').last()).toContainText('3 systems')
    await page.screenshot({ path: 'test-results/turn-antigravity-steps.png' })
    await expect(textbox).toBeEnabled()
    await textbox.fill('Use the corrected instruction')
    await panel.getByRole('button', { name: 'Send correction', exact: true }).click()
    await expect.poll(() => captured().some(item => item.steering === 'Use the corrected instruction')).toBe(true)
    await expect.poll(async () => (await page.evaluate(() => window.ambio.listDeliveryRuns('demo'))).at(-1)?.state).toBe('completed')
    const runs = await page.evaluate(() => window.ambio.listDeliveryRuns('demo'))
    expect(runs[0].transport).toBe('acp')
    expect(runs[0].thinking).toBe('low')
    const events = await page.evaluate(key => window.ambio.listDeliveryEvents('demo', key), runs[0].key)
    expect(events.filter(event => event.kind === 'text').map(event => [event.id?.startsWith('live:'), event.text, event.live])).toEqual([[true, 'Corrected fixture reply.', undefined]])
    expect(events.filter(event => event.id === 'edit')).toHaveLength(1)
    expect(events.some(event => 'content' in event)).toBe(false)
    // Three prompts used tokens: the /plan command, the request and the correction.
    expect(runs[0].usage).toMatchObject({ inputTokens: 300, outputTokens: 21 })
    await expect(panel.getByText('300 input, 21 output tokens')).toBeVisible()
    const server = captured().find(item => item.mcpServers)?.mcpServers[0]
    expect(server.env).toEqual([{ name: 'AMBIO_WORKSPACE_ID', value: 'demo' }])
    expect(server.args).toContain('--ambio-host=antigravity-cli')
    await setup.chooseModel('Claude Fixture')
    await textbox.fill('Switch the model')
    await panel.getByRole('button', { name: 'Start Antigravity CLI', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('Start a new conversation')
    expect(orders).toHaveLength(1)
    expect(captured().some(item => item.transport === 'print')).toBe(false)
    await panel.getByRole('button', { name: 'New conversation', exact: true }).click()
    await setup.chooseModel('Claude Fixture')
    await textbox.fill('Use the other model')
    await panel.getByRole('button', { name: 'Start Antigravity CLI', exact: true }).click()
    await expect.poll(() => captured().some(item => item.transport === 'print')).toBe(true)
    expect(captured().find(item => item.transport === 'print').args).toEqual(expect.arrayContaining(['--model', 'claude-fixture', '--dangerously-skip-permissions']))
    await expect(panel.locator('.ambio-inbox__transport')).toHaveCount(0)
    // Full access on the ACP connection approves the agent's request without a card.
    await panel.getByRole('button', { name: 'New conversation', exact: true }).click()
    await setup.chooseModel('Gemini Fixture')
    await setAgentAccess(panel, 'Antigravity CLI', 'Full access')
    await textbox.fill('Edit without asking')
    await panel.getByRole('button', { name: 'Start Antigravity CLI', exact: true }).click()
    await expect.poll(() => captured().filter(item => item.permission?.optionId === 'yes').length).toBe(2)
    expect(await app.evaluate(() => (globalThis as any).agyPermission)).toBe(null)
    await expect.poll(async () => (await page.evaluate(() => window.ambio.listDeliveryRuns('demo'))).filter(run => run.transport === 'acp').every(run => run.state === 'completed')).toBe(true)
    await page.screenshot({ path: 'test-results/antigravity-transport.png' })
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('opening the agent panel goes straight to the agent used last, with no introduction flashing first', async () => {
  test.setTimeout(60000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-agy-reopen-'))
  const root = path.join(home, 'project')
  fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.ambio'))
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Antigravity fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  fs.writeFileSync(path.join(home, '.ambio', 'agent-executable-overrides.json'), JSON.stringify({ 'antigravity-cli': path.resolve(__dirname, 'fixtures', 'antigravity-agent.cjs') }))
  const config = path.join(home, '.gemini', 'config')
  fs.mkdirSync(config, { recursive: true }); fs.writeFileSync(path.join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: { ambio: { command: 'fixture' } } }))
  const windowsProfile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(windowsProfile)) fs.mkdirSync(dir, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...windowsProfile, AMBIO_E2E: '1', AMBIO_E2E_AGENTS: '1', AMBIO_API_TOKEN: 'ambio-antigravity-reopen-ui-token-1234567' } })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1400, height: 1000 })
    // Every guide read except the handoff's, and Antigravity chosen here before.
    await skipAgentGuides(page)
    await page.evaluate(() => {
      const seen = JSON.parse(localStorage.getItem('ambio:destination-guides-seen') ?? '[]') as string[]
      localStorage.setItem('ambio:destination-guides-seen', JSON.stringify(seen.filter(id => id !== '')))
      localStorage.setItem('delivery_host_demo', 'antigravity-cli')
    })
    // Which agents are connected is slow to answer, so the agents arrive before the one to start on.
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/agent/presence') await new Promise(resolve => setTimeout(resolve, 2500))
      const body = url.pathname === '/api/canvas/history' ? { messages: [], nextCursor: '' } : url.pathname === '/api/agent/presence' ? { connections: [] } : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {})
    })
    await page.reload()
    await page.evaluate(() => {
      (window as any).__introSeen = false
      new MutationObserver(() => { const intro = document.querySelector('[role="dialog"][aria-label^="Before you use"]'); if (intro) (window as any).__introSeen = intro.getAttribute('aria-label') })
        .observe(document.body, { childList: true, subtree: true })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const panel = page.getByRole('complementary', { name: 'Agent inbox' })
    await expect(agentSetup(panel).trigger).toHaveAccessibleName(/^Client and model: Antigravity CLI/, { timeout: 15000 })
    expect(await page.evaluate(() => (window as any).__introSeen)).toBe(false)
    await expect(page.getByRole('dialog', { name: /^Before you use / })).toHaveCount(0)
  } finally { await app.close() }
})
