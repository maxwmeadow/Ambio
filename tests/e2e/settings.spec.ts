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
          familyId: `fixture-${index}`, familyLabel: 'Fixture', modality: index < 6 ? 'cli' : 'desktop', sharedSurfaces: [],
          detected: index < 10, configured: index < 10, configuredPaths: ['/fixture/config.json'],
          unreadablePaths: [], workflowInstalled: true, workflowPath: '/fixture/workflow.md',
          configPath: '/fixture/config.json', configOverride: null, command: null,
          restartAction: 'Restart agent', restartDetail: 'Restart to load the connection.', triggerKind: 'instruction',
        }))
      })
      // Nor the agents this computer could run.
      ipcMain.removeHandler('agent:delivery-hosts')
      ipcMain.handle('agent:delivery-hosts', () => [])
      let providers: any[] = [{ id: 'saved', kind: 'openai', name: 'My OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'saved-model', contextWindow: 64000, hasKey: true, persistentKey: true }]
      ipcMain.removeHandler('chat:providers'); ipcMain.handle('chat:providers', () => providers)
      ipcMain.removeHandler('chat:provider-test'); ipcMain.handle('chat:provider-test', () => ({ models: ['fixture-model'], detail: 'Connected to fixture provider.' }))
      ipcMain.removeHandler('chat:provider-save'); ipcMain.handle('chat:provider-save', (_event, input) => {
        const { apiKey: _key, ...safe } = input
        const saved = { ...safe, id: input.id ?? 'added', hasKey: true, persistentKey: true }
        providers = [...providers.filter(item => item.id !== saved.id), saved]
        return saved
      })
      ipcMain.removeHandler('chat:provider-remove'); ipcMain.handle('chat:provider-remove', (_event, id) => { providers = providers.filter(item => item.id !== id) })
      ipcMain.removeHandler('chatgpt:state'); ipcMain.handle('chatgpt:state', () => ({
        profiles: [{ id: 'account', label: 'Fixture account', email: 'fixture@example.test', connected: true, sharing: true, models: ['fixture-model'] }], activeId: 'account', model: 'fixture-model', secureStorage: true, signingIn: false,
      }))
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.setViewportSize({ width: 1400, height: 900 })
    const titlebar = page.locator('.ambio-workbench-titlebar')
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

    // The overview exposes the connection choices, not an empty configuration form.
    await nav.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(dialog.getByLabel('Service API key', { exact: true })).toHaveCount(0)
    const chatGPT = dialog.getByRole('region', { name: 'ChatGPT connection' })
    await expect(chatGPT.getByText('Connected', { exact: true })).toBeVisible()
    await expect(chatGPT.getByRole('button', { name: 'Manage usage' })).toBeVisible()
    await chatGPT.getByText('Account and model settings', { exact: true }).click()
    await expect(chatGPT.getByRole('combobox', { name: 'ChatGPT account' })).toHaveValue('account')
    await expect(chatGPT.getByRole('combobox', { name: 'ChatGPT model' })).toHaveValue('fixture-model')
    await chatGPT.getByText('Account and model settings', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit My OpenAI', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: 'Model provider' })).toBeDisabled()
    await expect(dialog.getByLabel('Service API key', { exact: true })).toHaveValue('')
    await dialog.getByRole('button', { name: 'Save service', exact: true }).click()
    await expect(dialog.getByLabel('Service API key', { exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add Anthropic API connection' }).click()
    await dialog.getByLabel('Service API key', { exact: true }).fill('fixture-key')
    await dialog.getByRole('navigation', { name: 'Agent connection types' }).getByRole('button', { name: 'Ambio runs it', exact: true }).click()
    await dialog.getByRole('navigation', { name: 'Agent connection types' }).getByRole('button', { name: 'Ambio chat', exact: true }).click()
    await expect(dialog.getByLabel('Service API key', { exact: true })).toHaveValue('fixture-key')
    await dialog.getByRole('button', { name: 'Test connection & find models' }).click()
    await expect(dialog.getByLabel('Service model', { exact: true })).toHaveValue('fixture-model')
    await dialog.getByRole('button', { name: 'Save service', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit Anthropic', exact: true }).click()
    await dialog.getByRole('button', { name: 'Remove service', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Edit Anthropic', exact: true })).toHaveCount(0)
    await expect(dialog.getByLabel('Service API key', { exact: true })).toHaveCount(0)

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
          await expect(dialog.getByRole('navigation', { name: 'Agent connection types' }).getByRole('button')).toHaveText(['Ambio chat', 'Ambio runs it', 'In another app'])
          await expect(dialog.getByLabel('Service API key', { exact: true })).toHaveCount(0)
          await page.screenshot({ path: test.info().outputPath(`settings-chat-${viewport.width}.png`) })
          await dialog.getByRole('navigation', { name: 'Agent connection types' }).getByRole('button', { name: 'Ambio runs it', exact: true }).click()
          await dialog.getByRole('button', { name: /^Fixture agent 0 —/ }).click()
          await expect(dialog.getByRole('region', { name: 'Agents Ambio runs' }).locator('.ambio-agent-connections__host')).toHaveCount(1)
          expect(await dialog.boundingBox()).toEqual(frame)
          await dialog.getByRole('button', { name: 'Show details for Fixture agent 0', exact: true }).click()
          await expect(dialog.getByRole('region', { name: 'Files for Fixture agent 0' })).toBeVisible()
          expect(await dialog.boundingBox()).toEqual(frame)
          await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
          await dialog.getByText('Disconnect agents from this computer', { exact: true }).click()
          await dialog.getByRole('button', { name: 'Remove…', exact: true }).scrollIntoViewIfNeeded()
          await expect(dialog.getByRole('button', { name: 'Remove…', exact: true })).toBeInViewport()
          await expect(dialog.getByRole('button', { name: /apps not found on this computer/ })).toHaveCount(0)
          await dialog.getByRole('navigation', { name: 'Agent connection types' }).getByRole('button', { name: 'In another app', exact: true }).click()
          await dialog.getByRole('button', { name: /^Fixture agent 6 —/ }).click()
          await expect(dialog.getByRole('region', { name: 'Agents in other apps' }).locator('.ambio-agent-connections__host')).toHaveCount(1)
          await page.screenshot({ path: test.info().outputPath(`settings-apps-${viewport.width}.png`) })
          expect(await dialog.boundingBox()).toEqual(frame)
          expect(await nav.boundingBox()).toEqual(navFrame)
          expect(await close.boundingBox()).toEqual(closeFrame)
        }
        const overflow = await panel.evaluate(element => element.scrollWidth - element.clientWidth)
        expect(overflow, `${section} overflows at ${viewport.width}px`).toBeLessThanOrEqual(1)
      }
      await nav.getByRole('button', { name: 'Agents', exact: true }).click()
      await expect(dialog.getByRole('heading', { name: 'ChatGPT', exact: true })).toBeVisible()
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
