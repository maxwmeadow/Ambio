import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

test('settings keeps its frame across sections and expanded content', async () => {
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
      args: ['.'],
      env: { ...env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
        AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' },
    })
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1400, height: 900 })
    const titlebar = page.locator('.ambio-launcher__titlebar')
    await expect(titlebar).toBeVisible()
    await expect(titlebar.getByText(/Architecture Workbench|Project Navigator/)).toHaveCount(0)
    await expect(titlebar.locator('.ambio-brand-mark')).toBeVisible()
    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsButton.click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
    const panel = dialog.locator('.ambio-settings__panel')
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    for (const viewport of [
      { width: 1400, height: 900 }, { width: 900, height: 600 },
      { width: 640, height: 480 }, { width: 460, height: 600 },
    ]) {
      await page.setViewportSize(viewport)
      await nav.getByRole('button', { name: 'General', exact: true }).click()
      const frame = await dialog.boundingBox()
      const navFrame = await nav.boundingBox()
      const closeFrame = await close.boundingBox()
      expect(frame?.width).toBe(Math.min(860, viewport.width - 48))
      expect(frame?.height).toBe(Math.min(640, viewport.height - 48))
      for (const section of ['Appearance', 'Agents', 'Privacy', 'Advanced', 'General']) {
        await nav.getByRole('button', { name: section, exact: true }).click()
        await expect(nav.getByRole('button', { name: section, exact: true })).toHaveAttribute('aria-current', 'page')
        expect(await dialog.boundingBox()).toEqual(frame)
        expect(await nav.boundingBox()).toEqual(navFrame)
        expect(await close.boundingBox()).toEqual(closeFrame)
        expect(await panel.evaluate(element => element.scrollTop)).toBe(0)
        expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        // Future sections can load or expand independently of their frame.
        await panel.evaluate(element => {
          const content = document.createElement('div')
          content.style.height = '1500px'; content.dataset.fixtureOverflow = ''
          content.textContent = 'Expanded settings content'; element.append(content)
          element.scrollTop = element.scrollHeight
        })
        await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        expect(await dialog.boundingBox()).toEqual(frame)
        expect(await nav.boundingBox()).toEqual(navFrame)
        expect(await close.boundingBox()).toEqual(closeFrame)
      }
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(settingsButton).toBeFocused()
  } finally {
    await app?.close()
    if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('ambio-settings-ui-')) rmSync(home, { recursive: true, force: true })
  }
})
