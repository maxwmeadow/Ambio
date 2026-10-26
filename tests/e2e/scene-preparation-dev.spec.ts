import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

// Packaged-app tests use production React, which does not replay mount effects.
// Exercise the real hook and worker under development React's StrictMode too.
for (const mode of ['worker', 'fallback']) {
test(`development effect replay prepares a map and reuses equivalent echoes (${mode})`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ambio-preparation-dev-'))
  let server: ViteDevServer | undefined
  let app: ElectronApplication | undefined
  try {
    server = await createServer({
      configFile: false, root: resolve('.'), cacheDir: join(home, 'vite-cache'), plugins: [react(), {
        name: 'preparation-test-page',
        configureServer(vite) {
          vite.middlewares.use('/preparation-test', async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html')
              response.end(await vite.transformIndexHtml('/preparation-test', `<html><head></head><body><div id="root"></div><script type="module" src="/tests/e2e/fixtures/preparation-dev.tsx"></script></body></html>`))
            } catch (error) { next(error) }
          })
        },
      }],
      server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/out/**', '**/test-results/**'] } },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    })
    await server.listen()
    const address = server.httpServer!.address() as { port: number }
    const entry = join(home, 'main.cjs')
    writeFileSync(entry, `const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(home)});
      app.whenReady().then(() => {
        const window = new BrowserWindow({ show: false });
        window.loadURL('http://127.0.0.1:${address.port}/preparation-test${mode === 'fallback' ? '?fallback=1' : ''}');
      });`)
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    app = await electron.launch({ args: [entry], env })
    const page = await app.firstWindow()
    page.on('pageerror', error => console.error(error))
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
    await page.reload()
    await expect(page.locator('#status')).toHaveText('ready', { timeout: 5_000 })
    await expect(page.locator('#preparations')).toHaveText('2')
    await page.getByRole('button', { name: 'Echo model' }).click()
    await expect(page.locator('#status')).toHaveText('ready')
    await expect(page.locator('#preparations')).toHaveText('2')
    await page.getByRole('button', { name: 'Change geometry' }).click()
    await expect(page.locator('#geometry')).toHaveText('720')
    await expect(page.locator('#preparations')).toHaveText('3')
    await page.getByRole('button', { name: 'Clear model' }).click()
    await expect(page.locator('#status')).toHaveText('empty')
    await page.getByRole('button', { name: 'Restore model' }).click()
    await expect(page.locator('#status')).toHaveText('ready')
    await expect(page.locator('#preparations')).toHaveText('4')
  } finally {
    await app?.close()
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
}
