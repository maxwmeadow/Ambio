import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

test('settings keeps its frame across sections, loading and expanded content', async () => {
  test.setTimeout(90_000)
  const home = mkdtempSync(join(tmpdir(), 'ambio-settings-ui-'))
  const appData = join(home, 'AppData', 'Roaming')
  const localAppData = join(home, 'AppData', 'Local')
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: ['.', ...(process.env.AMBIO_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])],
      env: { ...env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
        AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' },
    })
    // Deterministic agent rows without reading or changing installed agents.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agent:hosts')
      ipcMain.handle('agent:hosts', async () => {
        await new Promise(resolve => setTimeout(resolve, 150))
        return Array.from({ length: 12 }, (_, index) => ({
          id: `fixture-${index}`, label: `Fixture agent ${index}`, modalityLabel: `Fixture agent ${index}`,
          familyId: `fixture-${index}`, familyLabel: 'Fixture', modality: 'cli', sharedSurfaces: [],
          detected: index < 10, configured: index < 10, configuredPaths: ['/fixture/config.json'],
          unreadablePaths: [], workflowInstalled: true, workflowPath: '/fixture/workflow.md',
          configPath: '/fixture/config.json', configOverride: null, command: null,
          restartAction: 'Restart agent', restartDetail: 'Restart to load the connection.', triggerKind: 'instruction',
        }))
      })
    })
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1400, height: 900 })
    const titlebar = page.locator('.ambio-launcher__titlebar')
    await expect(titlebar).toBeVisible()
    await expect(titlebar.getByText('Architecture Workbench')).toHaveCount(0)
    await expect(titlebar.getByText('Projects', { exact: true })).toHaveCount(0)
    await expect(titlebar.locator('.ambio-wordmark')).toBeVisible()
    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsButton.click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
    const panel = dialog.locator('.ambio-settings__panel')
    const close = dialog.getByRole('button', { name: 'Close', exact: true })

    for (const viewport of [
      { width: 1400, height: 900 },
      { width: 900, height: 600 },
      { width: 640, height: 480 },
      { width: 460, height: 600 },
    ]) {
      await page.setViewportSize(viewport)
      await nav.getByRole('button', { name: 'General', exact: true }).click()
      const frame = await dialog.boundingBox()
      const navFrame = await nav.boundingBox()
      const closeFrame = await close.boundingBox()
      expect(frame).not.toBeNull()
      expect(frame!.width).toBeCloseTo(Math.min(860, viewport.width - 48), 0)
      expect(frame!.height).toBeCloseTo(Math.min(640, viewport.height - 48), 0)
      expect(frame!.x).toBeGreaterThanOrEqual(24)
      expect(frame!.y).toBeGreaterThanOrEqual(24)
      expect(frame!.y + frame!.height).toBeLessThanOrEqual(viewport.height - 24)

      for (const section of ['Appearance', 'Agents', 'Privacy & Data', 'Advanced', 'General']) {
        await nav.getByRole('button', { name: section, exact: true }).click()
        await expect(nav.getByRole('button', { name: section, exact: true })).toHaveAttribute('aria-current', 'page')
        expect(await dialog.boundingBox()).toEqual(frame)
        expect(await nav.boundingBox()).toEqual(navFrame)
        expect(await close.boundingBox()).toEqual(closeFrame)
        expect(await panel.evaluate(element => element.scrollTop)).toBe(0)
        if (section === 'Agents') {
          await expect(dialog.locator('.ambio-agent-connections__host')).toHaveCount(10)
          expect(await dialog.boundingBox()).toEqual(frame)
          await dialog.getByRole('button', { name: 'Show details for Fixture agent 0', exact: true }).click()
          await expect(dialog.getByRole('region', { name: 'Files for Fixture agent 0' })).toBeVisible()
          expect(await dialog.boundingBox()).toEqual(frame)
          await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
          await expect(dialog.getByRole('button', { name: 'Remove…', exact: true })).toBeInViewport()
          await dialog.getByRole('button', { name: 'Show 2 agents not found on this computer' }).click()
          await expect(dialog.locator('.ambio-agent-connections__host')).toHaveCount(12)
          expect(await dialog.boundingBox()).toEqual(frame)
          expect(await nav.boundingBox()).toEqual(navFrame)
          expect(await close.boundingBox()).toEqual(closeFrame)
        }
        const overflow = await panel.evaluate(element => element.scrollWidth - element.clientWidth)
        expect(overflow, `${section} overflows at ${viewport.width}px`).toBeLessThanOrEqual(1)
      }
      await nav.getByRole('button', { name: 'Agents', exact: true }).click()
      await expect(dialog.locator('.ambio-agent-connections__host')).toHaveCount(10)
      await page.screenshot({ path: test.info().outputPath(`settings-${viewport.width}.png`) })
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
  } finally {
    await app?.close()
    if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('ambio-settings-ui-')) {
      rmSync(home, { recursive: true, force: true })
    }
  }
})
