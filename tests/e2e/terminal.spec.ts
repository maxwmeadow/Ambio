import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, readFileSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('terminal runs a real interactive PTY, survives hiding, resizes, and shares the sidebar with agents', async ({}, info) => {
  test.setTimeout(90000)
  const home = mkdtempSync(join(tmpdir(), 'ambio-terminal-'))
  const root = join(home, 'project with spaces')
  mkdirSync(root); mkdirSync(join(home, '.ambio'))
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true }); mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  writeFileSync(join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Terminal fixture', rootPath: root, ignoredPaths: [], languageOverrides: {}, layoutPreferences: {} }]))
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
  const executablePath = process.env.AMBIO_TERMINAL_EXECUTABLE
  const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }), env: { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), AMBIO_E2E: '1', AMBIO_E2E_HOME: '1', AMBIO_E2E_ROOT: root } })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.waitForURL(/e2e=1/); await page.setViewportSize({ width: 1440, height: 900 })
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json: [] }))
    const workbench = new URL(page.url()); workbench.searchParams.delete('home'); await page.goto(workbench.toString())
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
    await page.keyboard.press('Control+Backquote')
    const panel = page.getByRole('complementary', { name: 'Terminal', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('tab')).toHaveCount(1, { timeout: 15000 })
    if (process.platform === 'win32') {
      await panel.getByRole('combobox', { name: 'Shell profile' }).selectOption({ label: 'Command Prompt' })
      await panel.getByRole('button', { name: '+ New', exact: true }).click()
      await panel.getByRole('button', { name: 'Close terminal 1', exact: true }).click()
    }
    const screen = panel.locator('.ambio-terminal__screen:not([hidden])')
    const input = screen.locator('textarea')
    await input.focus()
    await page.keyboard.type(`node -e "console.log('AMBIO_' + 'PTY_OK', process.cwd(), process.stdout.isTTY, process.stdin.isTTY)"`)
    await page.keyboard.press('Enter')
    await expect(screen).toContainText('AMBIO_PTY_OK', { timeout: 15000 })
    await expect(screen).toContainText(realpathSync(root))
    await expect(screen).toContainText('true true')
    await app.evaluate(({ clipboard }) => clipboard.writeText(`node -e "console.log('PASTE_' + 'OK')"`))
    await input.focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v'); await page.keyboard.press('Enter')
    await expect(screen).toContainText('PASTE_OK')
    await page.keyboard.type(`node -e "setTimeout(() => console.log('HIDDEN_' + 'OUTPUT'), 1500)"`); await page.keyboard.press('Enter')
    await page.keyboard.press('Control+Backquote'); await expect(panel).toBeHidden()
    await page.waitForTimeout(1800)
    await page.keyboard.press('Control+Backquote'); await expect(panel).toBeVisible()
    await expect(screen).toContainText('HIDDEN_OUTPUT')
    const before = await panel.boundingBox()
    const handle = panel.getByRole('separator', { name: 'Terminal width' })
    await handle.focus(); await handle.press('ArrowLeft')
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before!.width)
    await input.focus()
    await page.keyboard.type(`node -e "console.log('SIZE_' + 'OK', process.stdout.columns, process.stdout.rows)"`); await page.keyboard.press('Enter')
    await expect(screen).toContainText('SIZE_OK')
    await page.keyboard.type(`node -e "setInterval(() => {}, 1000)"`); await page.keyboard.press('Enter')
    await page.waitForTimeout(500); await page.keyboard.press('Control+c')
    // cmd asks whether to terminate a batch job only for batch wrappers; node is a native executable.
    await page.keyboard.type(`node -e "console.log('SIGNAL_' + 'OK')"`); await page.keyboard.press('Enter')
    await expect(screen).toContainText('SIGNAL_OK')
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(panel).toBeHidden()
    await expect(page.getByRole('complementary', { name: 'Agent inbox' })).toBeVisible()
    await page.keyboard.press('Control+Backquote'); await expect(panel).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Agent inbox' })).toBeHidden()
    await page.screenshot({ path: info.outputPath('terminal.png') })
    await input.focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter')
    await expect(panel.getByRole('tab')).toContainText('exited 0')
    await panel.getByRole('button', { name: 'Close terminal 1', exact: true }).click()
    await expect(panel.getByRole('tab')).toHaveCount(0)
    await panel.getByRole('button', { name: '+ New', exact: true }).click()
    await expect(panel.getByRole('tab')).toHaveCount(1)
    // A foreground child must terminate with its tab and with renderer reload.
    const runChild = async (file: string) => {
      await input.focus()
      await page.keyboard.type(`node -e "require('fs').writeFileSync('${file}', String(process.pid)); setInterval(() => {}, 1000)"`)
      await page.keyboard.press('Enter')
      await expect.poll(() => existsSync(join(root, file))).toBe(true)
      return Number(readFileSync(join(root, file), 'utf8'))
    }
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const tabChild = await runChild('tab-child.pid')
    await panel.getByRole('button', { name: 'Close terminal 1', exact: true }).click()
    await expect.poll(() => alive(tabChild)).toBe(false)
    await panel.getByRole('button', { name: '+ New', exact: true }).click()
    const reloadChild = await runChild('reload-child.pid')
    await page.reload()
    await expect.poll(() => alive(reloadChild)).toBe(false)
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
    await page.keyboard.press('Control+Backquote')
    await expect(panel.getByRole('tab')).toHaveCount(1)
    expect(errors).toEqual([])
    const refused = await page.evaluate(async () => {
      try { await window.ambio.terminal.start({ id: 'bad', workspaceId: 'unregistered', profileId: '', cols: 80, rows: 24 }); return false } catch { return true }
    })
    expect(refused).toBe(true)
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }) }
})
