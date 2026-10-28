import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_CLIENTS, CLI_CLIENTS } from '../../src/shared/agentDelivery'
import { hasConnectorLogo } from '../../src/renderer/components/connectorMarks'

test('setup keeps every client visible and locates, persists, rechecks and clears a CLI independently of its extension', async () => {
  test.setTimeout(90000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-discovery-ui-'))
  const root = path.join(home, 'project')
  const roaming = path.join(home, 'AppData', 'Roaming')
  const local = path.join(home, 'AppData', 'Local')
  for (const dir of [root, roaming, local, path.join(home, '.ambio')]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Discovery fixture', rootPath: root, ignoredPaths: [], createdAt: 1 }]))
  const extension = path.join(home, '.vscode', 'extensions', 'openai.chatgpt-1.2.3')
  fs.mkdirSync(extension, { recursive: true })
  fs.writeFileSync(path.join(extension, 'package.json'), '{}')
  const script = path.join(home, 'custom codex.js')
  fs.writeFileSync(script, 'console.log("codex-cli 1.2.3")')
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: {
    ...env, HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32') : root,
    AMBIO_E2E: '1', AMBIO_E2E_AGENTS: '1', AMBIO_E2E_ROOT: root,
    AMBIO_API_TOKEN: 'ambio-isolated-discovery-test-token-12345',
  } })
  let app: ElectronApplication | undefined
  try {
    app = await launch()
    let page = await app.firstWindow()
    const openSetup = async () => {
      const url = new URL(page.url()); url.searchParams.set('connect', '1')
      await page.goto(url.toString())
      await page.setViewportSize({ width: 1440, height: 1000 })
      await expect(page.getByRole('heading', { name: 'Choose who maps this project' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Rescan', exact: true })).toBeEnabled()
    }
    await openSetup()
    const agents = () => page.getByRole('radiogroup', { name: 'Agents' })
    for (const client of [...CLI_CLIENTS, ...APP_CLIENTS]) await expect(agents().getByRole('radio', { name: new RegExp(client.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toHaveCount(1)
    // Grouped wrapping pills: every route has its product mark, including
    // absent clients. Marks are bundled, so no remote image request is needed.
    // A client without a bundled mark (Grok) shows a neutral glyph instead.
    await expect(agents().locator('img')).toHaveCount([...CLI_CLIENTS, ...APP_CLIENTS].filter(client => hasConnectorLogo(client.id)).length + 1)
    await expect.poll(() => agents().locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    const pillBoxes = await agents().getByRole('radio').evaluateAll(pills => pills.map(pill => {
      const { x, y, width, height } = pill.getBoundingClientRect(); return { x, y, width, height }
    }))
    expect(pillBoxes.some((box, index) => index > 0 && Math.abs(box.y - pillBoxes[index - 1].y) < 2)).toBe(true)
    for (const width of [1000, 600, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await agents().evaluate(group => group.scrollWidth - group.clientWidth)).toBeLessThanOrEqual(1)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: 'test-results/connector-pills.png' })
    await agents().getByRole('radio', { name: /^Ambio chat/ }).click()
    const chatSidebar = page.getByRole('region', { name: 'Ambio chat', exact: true })
    for (const [link, kind] of [
      ['Sign in with ChatGPT', 'chatgpt'], ['OpenAI', 'openai'], ['Anthropic', 'anthropic'],
      ['Google', 'google'], ['OpenAI-compatible provider', 'compatible'],
    ]) {
      await chatSidebar.getByRole('button', { name: link, exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await expect(settings).toBeVisible()
      await expect(settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Agents', exact: true })).toHaveAttribute('aria-current', 'page')
      if (kind === 'chatgpt') {
        await expect(settings.getByRole('heading', { name: 'ChatGPT', exact: true })).toBeInViewport()
        await expect(settings.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toBeInViewport()
      } else {
        await expect(settings.getByRole('combobox', { name: 'Model provider', exact: true })).toHaveValue(kind)
        await expect(settings.getByLabel(kind === 'compatible' ? 'Service URL' : 'Service API key', { exact: true })).toBeFocused()
        await expect(settings.getByRole('button', { name: 'Remove service', exact: true })).toHaveCount(0)
      }
      await settings.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(chatSidebar.getByRole('button', { name: link, exact: true })).toBeFocused()
    }
    await page.screenshot({ path: 'test-results/ambio-chat-sidebar.png' })
    await chatSidebar.getByRole('button', { name: 'Close connector details' }).click()
    const codex = () => agents().getByRole('radio', { name: /^Codex CLI / })
    const sidebar = () => page.getByRole('region', { name: 'Codex CLI', exact: true })
    await expect(page.locator('.ambio-choose__sidebar')).toHaveCount(0)
    await expect(codex()).toContainText('Not found')
    await expect(agents().getByRole('radio', { name: /^GitHub Copilot CLI/ })).toContainText('Not found')
    await expect(agents().getByRole('radio', { name: /^Codex IDE extension/ })).toContainText('Ambio not added yet')
    await codex().click()
    await expect(sidebar()).toBeVisible()
    // Details overlay the field agent and never consume space below the pills.
    await expect.poll(() => sidebar().evaluate(panel => {
      const area = panel.closest('.ambio-connect__mascot')!.getBoundingClientRect()
      const bounds = panel.getBoundingClientRect()
      return Math.abs(area.right - bounds.right) < 2 && Math.abs(area.bottom - bounds.bottom) < 2
    })).toBe(true)
    await sidebar().getByRole('button', { name: 'Close connector details' }).click()
    await expect(sidebar()).toHaveCount(0)
    await expect(codex()).toBeFocused()
    await page.keyboard.press('Space')
    await expect(sidebar()).toBeVisible()
    await sidebar().getByRole('button', { name: 'Locate Codex CLI…' }).focus()
    await page.keyboard.press('Escape')
    await expect(sidebar()).toHaveCount(0)
    await expect(codex()).toBeFocused()
    await page.setViewportSize({ width: 390, height: 1000 })
    await codex().click()
    await expect(sidebar().getByRole('button', { name: 'Locate Codex CLI…' })).toBeInViewport()
    expect(await sidebar().evaluate(panel => panel.scrollWidth - panel.clientWidth)).toBeLessThanOrEqual(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sidebar().evaluate(panel => getComputedStyle(panel).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await codex().focus()
    await page.keyboard.press('ArrowRight')
    // Arrows move to the next pill in CLI_CLIENTS order.
    const afterCodex = CLI_CLIENTS[CLI_CLIENTS.findIndex(client => client.id === 'codex') + 1].label
    await expect(agents().getByRole('radio', { name: new RegExp(`^${afterCodex} `) })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(codex()).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('button', { name: /^Map with Codex/ })).toHaveCount(0)
    await expect(page.locator('.ambio-connect__mascot')).toContainText('Needs setup')
    await page.screenshot({ path: 'test-results/agent-discovery-missing.png' })

    // The extension can be connected through the existing canonical installer,
    // while its separate standalone CLI remains absent.
    const installed = await page.evaluate(root => window.ambio.installAgent('codex-ide', root), root)
    expect(installed.ok).toBe(true)
    const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    expect(config).toContain('--ambio-host=codex')
    await page.getByRole('button', { name: 'Rescan', exact: true }).click()
    await expect(agents().getByRole('radio', { name: /^Codex IDE extension/ })).toContainText('Ambio added')
    await expect(codex()).toContainText('Not found')

    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, script)
    await page.getByRole('button', { name: 'Locate Codex CLI…' }).click()
    await expect(codex()).toContainText('On this computer')
    await expect(page.locator('.ambio-choose__discovery')).toContainText(script)
    await expect(page.getByRole('button', { name: /^Map with Codex CLI/ })).toBeEnabled()
    const target = await page.evaluate(() => window.ambio.listDeliveryHosts().then(hosts => hosts.find(host => host.id === 'codex')))
    expect(target?.executableOverride).toBe(script)
    // Actual delivery uses the same remembered executable, with literal stdin.
    fs.writeFileSync(script, 'const fs=require("fs");if(process.argv.includes("--version")){console.log("codex-cli 1.2.3")}else{fs.writeFileSync("delivered.json",JSON.stringify({args:process.argv.slice(2),prompt:fs.readFileSync(0,"utf8"),workspace:process.env.AMBIO_WORKSPACE_ID}));}')
    await app.evaluate(() => {
      ;(globalThis as any).fetch = async () => new Response(JSON.stringify({ id: 'discovery-order', workspaceId: 'demo', deliveryMode: 'addressed', status: 'queued', mode: 'ask' }))
    })
    await page.evaluate(() => window.ambio.deliverWorkOrder({ workspaceId: 'demo', messageId: 'discovery-order', hostId: 'codex' }))
    await expect.poll(() => fs.existsSync(path.join(root, 'delivered.json'))).toBe(true)
    const delivered = JSON.parse(fs.readFileSync(path.join(root, 'delivered.json'), 'utf8'))
    expect(delivered.workspace).toBe('demo'); expect(delivered.prompt).toContain('discovery-order')
    await page.screenshot({ path: 'test-results/agent-discovery-located.png' })

    await app.close()
    app = await launch(); page = await app.firstWindow()
    await openSetup()
    await codex().click()
    await expect(codex()).toContainText('On this computer')
    await expect(page.locator('.ambio-choose__discovery')).toContainText(script)
    fs.rmSync(script)
    await page.getByRole('button', { name: 'Rescan', exact: true }).click()
    await expect(codex()).toContainText('Could not check')
    await expect(page.locator('.ambio-choose__detail')).toContainText('missing, inaccessible')
    await expect(page.getByRole('button', { name: /^Map with Codex/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Use automatic detection', exact: true }).click()
    await expect(codex()).toContainText('Not found')

    // Rescan must discover newly installed CLIs, without remounting this step.
    const pkg = path.join(home, '.local', 'bin', 'node_modules', '@openai', 'codex', 'bin')
    fs.mkdirSync(pkg, { recursive: true }); fs.writeFileSync(path.join(pkg, 'codex.js'), 'console.log("codex-cli 1.2.3")')
    await page.getByRole('button', { name: 'Rescan', exact: true }).click()
    await expect(codex()).toContainText('On this computer')
    await expect(page.locator('.ambio-choose__discovery')).toContainText(path.join(pkg, 'codex.js'))

    // A read failure preserves the catalog and exposes retry rather than absence.
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('agent:delivery-hosts'); ipcMain.handle('agent:delivery-hosts', () => { throw new Error('fixture scan failure') }) })
    await page.getByRole('button', { name: 'Rescan', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Could not check CLI installations' })).toBeVisible()
    await expect(codex()).toContainText('Could not check')
    await expect(agents().getByRole('radio')).toHaveCount(CLI_CLIENTS.length + APP_CLIENTS.length + 1)
    await page.screenshot({ path: 'test-results/agent-discovery-error.png' })

    // An older, delayed scan cannot overwrite a newer successful refresh.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agent:delivery-hosts')
      let resolveOld: (value: unknown) => void
      let calls = 0
      ;(globalThis as any).resolveOldDiscovery = () => resolveOld([])
      ipcMain.handle('agent:delivery-hosts', () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve }) : [{ id: 'codex', label: 'Codex CLI', route: 'run', available: true, executablePath: 'newer-result', detail: 'fixture' }])
    })
    await page.getByRole('button', { name: 'Rescan', exact: true }).click()
    await page.evaluate(() => window.dispatchEvent(new Event('ambio:chat-providers-changed')))
    await expect(codex()).toContainText('On this computer')
    await app.evaluate(() => (globalThis as any).resolveOldDiscovery())
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('.ambio-choose__discovery')).toContainText('newer-result')
  } finally {
    if (app) await app.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
