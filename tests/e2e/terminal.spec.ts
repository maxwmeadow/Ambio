import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, readFileSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { skipAgentGuides } from './agentGuides'

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
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json:
      new URL(route.request().url()).pathname === '/api/canvas/history' ? { messages: [], nextCursor: '' } : [] }))
    await skipAgentGuides(page)
    const workbench = new URL(page.url()); workbench.searchParams.delete('home'); await page.goto(workbench.toString())
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
    await page.keyboard.press('Control+Backquote')
    const panel = page.getByRole('complementary', { name: 'Terminal', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('tab')).toHaveCount(1, { timeout: 15000 })
    await expect(panel.locator('footer')).toHaveCount(0)
    expect((await panel.locator('header').boundingBox())!.height).toBeLessThanOrEqual(35)
    if (process.platform === 'win32') {
      await panel.getByText('…', { exact: true }).click()
      await panel.getByRole('combobox', { name: 'Shell profile' }).selectOption({ label: 'Command Prompt' })
      await panel.getByRole('button', { name: 'New terminal', exact: true }).click()
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
    const terminalWidth = (await panel.boundingBox())!.width
    const canvasRight = (await page.locator('[data-ambio-canvas]').first().boundingBox())!.x + (await page.locator('[data-ambio-canvas]').first().boundingBox())!.width
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(panel).toBeHidden()
    const agent = page.getByRole('complementary', { name: 'Agent inbox' })
    await expect(agent).toBeVisible()
    expect((await agent.boundingBox())!.width).toBe(terminalWidth)
    const handoff = await page.evaluate(async () => {
      const frames = []
      for (let i = 0; i < 12; i++) {
        const panels = [...document.querySelectorAll<HTMLElement>('.ambio-inbox, .ambio-terminal')].filter(panel => panel.offsetWidth && panel.offsetHeight)
        const canvas = document.querySelector('[data-ambio-canvas]')!.getBoundingClientRect()
        const slot = panels[0].closest('.ambio-workbench-sidebar')!
        frames.push({ visible: panels.length, x: new DOMMatrixReadOnly(getComputedStyle(slot).transform).m41, moving: slot.getAnimations().some(animation => animation.playState === 'running'), right: canvas.right })
        await new Promise(requestAnimationFrame)
      }
      return frames
    })
    for (const frame of handoff) { expect(frame.visible).toBe(1); expect(frame.x).toBe(0); expect(frame.moving).toBe(false); expect(frame.right).toBeCloseTo(canvasRight, 0) }
    const agentHandle = (await agent.getByRole('separator', { name: 'Resize the agent panel' }).boundingBox())!
    await page.mouse.move(agentHandle.x + agentHandle.width / 2, agentHandle.y + 100)
    await page.mouse.down(); await page.mouse.move(agentHandle.x - 80, agentHandle.y + 100); await page.mouse.up()
    const agentWidth = (await agent.boundingBox())!.width
    expect(agentWidth).toBeGreaterThan(terminalWidth)
    await page.keyboard.press('Control+Backquote'); await expect(panel).toBeVisible()
    await expect(agent).toBeHidden()
    expect((await panel.boundingBox())!.width).toBe(agentWidth)
    await page.screenshot({ path: info.outputPath('terminal.png') })
    await page.setViewportSize({ width: 650, height: 900 })
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThanOrEqual(553)
    const narrowWidth = (await panel.boundingBox())!.width
    await page.getByRole('button', { name: /^Message agent/ }).click()
    await expect(agent).toBeVisible()
    expect((await agent.boundingBox())!.width).toBe(narrowWidth)
    await page.keyboard.press('Control+Backquote'); await expect(panel).toBeVisible()
    expect((await panel.boundingBox())!.width).toBe(narrowWidth)
    await page.setViewportSize({ width: 1440, height: 900 })
    // Restore the prior authored width after exercising the shared narrow bound.
    const restoredHandle = (await handle.boundingBox())!
    await page.mouse.move(restoredHandle.x + restoredHandle.width - 1, restoredHandle.y + 120)
    await page.mouse.down(); await page.mouse.move(1440 - agentWidth, restoredHandle.y + 120); await page.mouse.up()
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(agentWidth)
    await input.focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter')
    await expect(panel.getByRole('tab')).toContainText('exited 0')
    await panel.getByRole('button', { name: 'Close terminal 1', exact: true }).click()
    await expect(panel.getByRole('tab')).toHaveCount(0)
    await panel.getByRole('button', { name: 'New terminal', exact: true }).click()
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
    await panel.getByRole('button', { name: 'New terminal', exact: true }).click()
    const reloadChild = await runChild('reload-child.pid')
    await page.reload()
    await expect.poll(() => alive(reloadChild)).toBe(false)
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
    await page.keyboard.press('Control+Backquote')
    await expect(panel.getByRole('tab')).toHaveCount(1)
    expect((await panel.boundingBox())!.width).toBe(agentWidth)
    expect(errors).toEqual([])
    const refused = await page.evaluate(async () => {
      try { await window.ambio.terminal.start({ id: 'bad', workspaceId: 'unregistered', profileId: '', cols: 80, rows: 24 }); return false } catch { return true }
    })
    expect(refused).toBe(true)
    // Opening/closing still animate the common slot; only a content handoff
    // stays still. Sample actual keyframes, including an intermediate position.
    let motionCapture = 0
    const motion = async (close = false) => {
      const result = await page.evaluate(async close => {
        const slot = document.querySelector<HTMLElement>('.ambio-workbench-sidebar')!
        const root = document.documentElement
        if (close) {
          slot.querySelector<HTMLButtonElement>('[aria-label="Hide terminal"], [aria-label="Close agent inbox"]')!.click()
          await new Promise(requestAnimationFrame)
        }
        const animation = root.getAnimations()[0]
        if (!animation) return null
        animation.pause(); await animation.ready
        const frames = []
        for (const fraction of [.25, .5, .75]) {
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * fraction
          await new Promise(requestAnimationFrame)
          const bounds = slot.getBoundingClientRect()
          const canvas = document.querySelector<HTMLElement>('[data-ambio-canvas]')!
          const exposed = document.elementFromPoint(bounds.left - 8, bounds.top + 100)
          frames.push({ x: new DOMMatrixReadOnly(getComputedStyle(slot).transform).m41, edgeDifference: bounds.left - canvas.getBoundingClientRect().right,
            liveCanvas: Boolean(exposed?.closest('[data-ambio-canvas]')) })
        }
        if (!close) {
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * .25
          await new Promise(requestAnimationFrame)
        }
        return { name: getComputedStyle(root).animationName, frames, width: slot.offsetWidth, inert: slot.inert }
      }, close)
      if (!close) await page.screenshot({ path: info.outputPath(`sidebar-opening-${motionCapture++}.png`) })
      // Release script-seeked fill before testing the next CSS animation.
      await page.evaluate(() => document.documentElement.getAnimations().forEach(animation => { animation.finish(); animation.cancel() }))
      return result
    }
    for (const kind of ['terminal', 'agent']) {
      if (kind === 'agent') {
        await page.getByRole('button', { name: /^Message agent/ }).click()
        await expect(agent).toBeVisible()
      }
      const entered = await motion()
      expect(entered?.name).toBe('ambioWorkbenchSidebarIn')
      const closing = await motion(true)
      expect(closing?.name).toBe('ambioWorkbenchSidebarOut')
      for (const result of [entered!, closing!]) for (const frame of result.frames) {
        expect(frame.x).toBeGreaterThan(0); expect(frame.x).toBeLessThan(result.width)
        expect(Math.abs(frame.edgeDifference)).toBeLessThan(1)
        expect(frame.liveCanvas).toBe(true)
      }
      expect(closing!.inert).toBe(true)
      await expect(page.locator('.ambio-workbench-sidebar')).toBeHidden()
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.keyboard.press('Control+Backquote'); await expect(panel).toBeVisible()
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).animationName)).toBe('none')
    await panel.getByRole('button', { name: 'Hide terminal' }).click()
    await expect(page.locator('.ambio-workbench-sidebar')).toBeHidden()
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }) }
})
