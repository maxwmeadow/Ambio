import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('Send launches the selected CLI after saving, preserves failures, and supports editor handoff', async () => {
  test.setTimeout(90000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-delivery-ui-'))
  const root = path.join(home, 'project')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(root); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.ambio'))
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Delivery fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  const fakeAgent = 'const fs=require("fs");const host=process.env.AMBIO_AGENT_HOST;const prompt=host==="copilot-cli"?process.argv[process.argv.indexOf("--prompt")+1]:fs.readFileSync(0,"utf8");fs.writeFileSync("captured-"+host+".json",JSON.stringify({args:process.argv.slice(2),prompt,cwd:process.cwd(),workspace:process.env.AMBIO_WORKSPACE_ID}));fs.writeSync(1,"Fixture agent started");process.exit(host==="copilot-cli"?7:0)'
  const scripts: Record<string, string> = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js', copilot: '@github/copilot/index.js' }
  for (const [name, entry] of Object.entries(scripts)) {
    const script = path.join(bin, 'node_modules', entry)
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, fakeAgent)
    if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${fakeAgent}`, { mode: 0o755 })
  }
  if (process.platform !== 'win32') fs.writeFileSync(path.join(bin, 'zed'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(root, 'editor-opened.json'))},JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  // Only the stand-in agents are on PATH. Windows also needs its own system
  // folder there, or Electron cannot start its crash handler and exits.
  const launchPath = process.platform === 'win32' ? [bin, path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')].join(path.delimiter) : bin
  // Electron resolves its data folders from these on Windows; they must exist
  // under the stand-in home or it has nowhere to keep its crash database.
  const windowsProfile = process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}
  for (const dir of Object.values(windowsProfile)) fs.mkdirSync(dir, { recursive: true })
  const app = await electron.launch({
    args: ['.', ...(process.env.AMBIO_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])],
    env: { ...env, HOME: home, USERPROFILE: home, ...windowsProfile, PATH: launchPath, AMBIO_E2E: '1', AMBIO_E2E_AGENTS: '1', AMBIO_API_TOKEN: 'ambio-isolated-ui-delivery-test-token-12345' },
  })
  try {
    const page = await app.firstWindow()
    expect(await page.evaluate(() => window.ambio.listDeliveryHosts())).toHaveLength(10)
    await page.setViewportSize({ width: 1280, height: 1000 })
    const orders: any[] = []
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      let body: any = []
      if (url.pathname === '/api/canvas/send') {
        const sent = route.request().postDataJSON()
        orders.push({ ...sent, status: 'queued', createdAt: Date.now() }); body = orders.at(-1)
        // Main reads the durable request, independently of renderer routing.
        await app.evaluate((_, order) => {
          const runtime = globalThis as any
          runtime.deliveryOrders ??= {}
          runtime.deliveryOrders[order.id] = order
          runtime.fetch = async (input: string) => {
            const url = new URL(String(input))
            const found = runtime.deliveryOrders[url.searchParams.get('messageId') ?? '']
            return new Response(JSON.stringify(found ?? { error: 'not found' }), { status: found ? 200 : 404 })
          }
        }, body)
      }
      if (url.pathname === '/api/canvas/cancel') {
        const { msgId } = route.request().postDataJSON()
        const order = orders.find(item => item.id === msgId)
        if (order) order.status = 'cancelled'
      }
      if (url.pathname === '/api/canvas/history') body = { messages: [...orders].reverse(), nextCursor: '', availableCount: orders.length }
      if (url.pathname === '/api/agent/presence') body = { connected: false, connections: [] }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.getByRole('button', { name: /^Message agent/ }).click()
    const inbox = page.getByRole('complementary', { name: 'Agent inbox' })
    const destination = inbox.getByRole('combobox', { name: 'Work-order destination' })
    await expect(destination.locator('option')).toHaveCount(12)
    // The first time an agent is chosen, its guide stands in front of everything until confirmed.
    const intro = page.getByRole('dialog', { name: /^Before you use / })
    const confirm = () => intro.getByRole('button', { name: 'Got it' }).click()
    await expect(intro).toBeVisible()
    await confirm()
    await destination.selectOption('codex')
    await expect(intro).toHaveAccessibleName('Before you use OpenAI Codex (CLI)')
    await expect(intro).toContainText('Choose Codex and send.')
    await expect(intro).toContainText('press the info button next to the agent in the message box')
    await page.screenshot({ path: 'test-results/agent-delivery-introduction.png' })
    await confirm()
    await expect(intro).toBeHidden()
    // The info button shows the same guide, and its picker is the destination picker.
    await inbox.getByRole('button', { name: 'How each agent works here' }).click()
    const guide = inbox.getByRole('dialog', { name: 'How each agent works here' })
    const guidePicker = guide.getByRole('combobox', { name: 'Agent to read about' })
    await expect(guidePicker).toHaveValue('codex')
    await expect(guide).toContainText('Choose Codex and send.')
    await page.screenshot({ path: 'test-results/agent-delivery-guide.png' })
    await guidePicker.selectOption('claude-code')
    await expect(destination).toHaveValue('claude-code')
    // A first choice made from the guide is introduced too.
    await expect(intro).toHaveAccessibleName('Before you use Claude Code (CLI)')
    await confirm()
    await destination.selectOption('codex')
    await expect(intro).toBeHidden()
    await inbox.getByRole('button', { name: 'How each agent works here' }).click()
    await expect(guidePicker).toHaveValue('codex')
    await page.keyboard.press('Escape')
    await expect(guide).toBeHidden()
    for (const [host, label] of [['claude-code', 'Claude Code (CLI)'], ['codex', 'OpenAI Codex (CLI)'], ['copilot-cli', 'GitHub Copilot (CLI)']]) {
      await destination.selectOption(host)
      if (host === 'copilot-cli') await confirm()
      // Claude Code's models are offered beside the request type; the choice reaches its command line.
      if (host === 'claude-code') {
        await inbox.getByRole('button', { name: 'Model: Default' }).click()
        await inbox.getByRole('menuitemradio', { name: 'Opus' }).click()
        await expect(inbox.getByRole('button', { name: 'Model: Opus' })).toBeVisible()
        await page.locator('.ambio-inbox__compose').screenshot({ path: 'test-results/composer-claude.png' })
      }
      await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill(`Handle only the ${host} fixture.`)
      const sentBefore = orders.length
      await inbox.locator('form').getByRole('button', { name: `Start ${label}` }).click()
      // The previous unanswered turn is withdrawn first, so the new order lands a moment later.
      await expect.poll(() => orders.length).toBe(sentBefore + 1)
      const captured = path.join(root, `captured-${host}.json`)
      // Copilot is first tried as an agent session; the stand-in cannot hold one,
      // so the same turn then runs in print mode. Wait for the run that got the prompt.
      await expect.poll(() => { try { return String(JSON.parse(fs.readFileSync(captured, 'utf8')).prompt) } catch { return '' } }).toContain(orders.at(-1).id)
      const actual = JSON.parse(fs.readFileSync(captured, 'utf8'))
      expect(actual.workspace).toBe('demo'); expect(actual.cwd).toBe(fs.realpathSync(root))
      if (host === 'claude-code') expect(actual.args[actual.args.indexOf('--model') + 1]).toBe('opus')
      expect(actual.prompt).toContain(orders.at(-1).id)
      expect(actual.prompt).toContain('expectedWorkspaceId "demo"')
      // The stand-in exits without replying: the turn says so in one line, and the next message replaces it.
      await expect(inbox.locator('.ambio-inbox__turn-status').last()).toContainText(host === 'copilot-cli' ? `${label} stopped without an answer.` : `${label} finished without replying.`)
      await expect(inbox.locator('.ambio-inbox__turn-status').last().getByRole('button', { name: 'Try again' })).toBeVisible()
    }
    // The nonzero process exit leaves one saved work order, with output and handoff.
    expect(orders).toHaveLength(3)
    // Earlier turns whose runs ended unanswered were withdrawn when the next message went.
    await expect(inbox.locator('.ambio-inbox__turn-status[data-state="stopped"]')).toHaveText(['Cancelled', 'Cancelled'])
    await expect(inbox.getByRole('button', { name: 'Show output' })).toHaveCount(1)
    const firstMessageId = orders.at(-1).id
    const modifiedAt = fs.statSync(path.join(root, 'captured-copilot-cli.json')).mtimeMs
    await page.evaluate(messageId => window.ambio.deliverWorkOrder({ workspaceId: 'demo', messageId, hostId: 'copilot-cli' }), firstMessageId)
    expect(fs.statSync(path.join(root, 'captured-copilot-cli.json')).mtimeMs).toBe(modifiedAt)
    expect(orders.at(-1).id).toBe(firstMessageId)
    if (process.platform !== 'win32') {
      await destination.selectOption('zed')
      await confirm()
      await inbox.getByRole('textbox', { name: 'Instruction for your agent' }).fill('Discuss this in Zed.')
      await inbox.locator('form').getByRole('button', { name: 'Copy + open Zed Editor' }).click()
      await expect.poll(() => fs.existsSync(path.join(root, 'editor-opened.json'))).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(root, 'editor-opened.json'), 'utf8'))).toEqual([root])
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(orders.at(-1).id)
      await expect(inbox.getByRole('status').filter({ hasText: 'work has not started yet' })).toBeVisible()
    }
    await page.screenshot({ path: 'test-results/agent-delivery.png' })
    // The panel widens from its left edge, and keeps that width.
    const before = (await inbox.boundingBox())!
    const handle = (await inbox.getByRole('separator', { name: 'Resize the agent panel' }).boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 200, handle.y + handle.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await inbox.boundingBox())!.width - before.width)).toBeGreaterThan(190)
    expect(Number(await page.evaluate(() => localStorage.getItem('ambio:inbox-width')))).toBeGreaterThan(before.width + 190)
    await page.locator('.ambio-inbox__compose').screenshot({ path: 'test-results/composer-wide.png' })
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
