import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('ChatGPT settings handle consent, models, account switching and sign-out through safe IPC', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ambio-chatgpt-ui-'))
  const appData = join(home, 'AppData', 'Roaming'), localAppData = join(home, 'AppData', 'Local')
  mkdirSync(appData, { recursive: true }); mkdirSync(localAppData, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
  const app = await electron.launch({
    args: ['.', ...(process.env.AMBIO_HEADLESS_E2E === '1' && process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])],
    env: { ...env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' },
  })
  try {
    // The actual main-process guard rejects a foreign window even before
    // network operations are disabled by AMBIO_E2E.
    const rejected = await app.evaluate(async ({ BrowserWindow }) => {
      const foreign = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
      try {
        await foreign.loadURL('about:blank')
        return await foreign.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('chatgpt:state').then(() => 'accepted', error => error.message)`)
      } finally { foreign.destroy() }
    })
    expect(rejected).toContain('Untrusted ChatGPT request')
    const mainPage = await app.firstWindow()
    expect((await mainPage.evaluate(() => window.ambio.getChatGPTState())).signingIn).toBe(false)
    await app.evaluate(({ ipcMain }) => {
      const state: any = { profiles: [], secureStorage: true, signingIn: false }
      const handle = (channel: string, callback: (...args: any[]) => unknown) => {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => callback(...args))
      }
      handle('chatgpt:state', () => state)
      handle('chatgpt:sign-in', (profileId?: string) => {
        if (profileId) Object.assign(state.profiles.find((profile: any) => profile.id === profileId), { sharing: true, model: 'model-one', models: ['model-one', 'model-two'] })
        else {
          const id = `connection-${state.profiles.length + 1}`
          state.profiles.push({ id, label: `Connection ${state.profiles.length + 1}`, email: 'same@example.com', connected: true, sharing: state.profiles.length > 0, model: 'model-one', models: ['model-one', 'model-two'] })
          state.activeId = id
        }
        return state
      })
      handle('chatgpt:models', () => [{ slug: 'model-one', displayName: 'Model One' }, { slug: 'model-two', displayName: 'Model Two' }])
      handle('chatgpt:select-model', (slug: string) => { state.model = slug; return state })
      handle('chatgpt:select-profile', (id: string) => { state.activeId = id; state.model = undefined; return state })
      handle('chatgpt:sign-out', () => {
        const profile = state.profiles.find((item: any) => item.id === state.activeId)
        profile.connected = false; profile.sharing = false
        return { state, detail: 'Signed out locally. Remote revocation could not be confirmed.' }
      })
      handle('chatgpt:usage', () => {})
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Agents', exact: true }).click()
    const connection = dialog.getByRole('region', { name: 'ChatGPT connection' })
    await expect(connection.getByRole('button', { name: 'Continue with ChatGPT' })).toBeEnabled()
    await expect(connection).not.toContainText('Codex CLI')
    await connection.getByRole('button', { name: 'Continue with ChatGPT' }).click()
    await expect(connection).toContainText('plan usage was not approved')
    await expect(connection.getByRole('combobox', { name: 'ChatGPT model' })).toHaveCount(0)
    await connection.getByRole('button', { name: 'Reconnect ChatGPT' }).click()
    await expect(connection).toContainText('ChatGPT plan usage enabled')
    await connection.getByRole('combobox', { name: 'ChatGPT model' }).selectOption('model-two')
    await expect(connection.getByRole('combobox', { name: 'ChatGPT model' })).toHaveValue('model-two')
    await connection.getByRole('button', { name: 'Add account or workspace' }).click()
    const accounts = connection.getByRole('combobox', { name: 'ChatGPT account' })
    await expect(accounts.locator('option')).toHaveCount(2)
    await expect(accounts).toHaveValue('connection-2')
    await accounts.selectOption('connection-1')
    await expect(accounts).toHaveValue('connection-1')
    await connection.getByRole('button', { name: 'Manage usage' }).click()
    await connection.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(connection).toContainText('Remote revocation could not be confirmed')
    await expect(connection.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
    await expect(connection.getByRole('combobox', { name: 'ChatGPT model' })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('chatgpt-settings.png') })
  } finally {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  }
})
