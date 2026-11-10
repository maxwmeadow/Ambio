import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('keeps the startup splash visible while deciding whether to resume a project', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ambio-startup-'))
  const appData = join(home, 'AppData', 'Roaming'), localData = join(home, 'AppData', 'Local')
  const config = join(home, '.ambio'), project = join(home, 'project')
  for (const dir of [appData, localData, config, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(project, 'main.ts'), 'export const ready = true\n')
  writeFileSync(join(config, 'projects.json'), JSON.stringify([{
    id: 'startup-fixture', name: 'Startup fixture', rootPath: project, ignoredPaths: [],
    openedAt: 1, sourceBoundariesReviewedAt: 1, workbenchOpenedAt: 1,
  }]))
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home,
      APPDATA: appData, LOCALAPPDATA: localData, AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' } })
    const page = await app.firstWindow()
    await page.waitForURL(/e2e=1/)
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json: [] }))
    const startupUrl = new URL(page.url())
    startupUrl.searchParams.delete('e2e')
    startupUrl.searchParams.delete('home')
    const splash = page.getByRole('status', { name: 'Loading Ambio' })
    const launcher = page.locator('.ambio-launcher')
    const workbench = page.locator('.ambio-toolbar')

    for (const resumeId of ['startup-fixture', null]) {
      await app.evaluate(({ ipcMain }) => {
        const gate = { entered: false, release: (_id: string | null) => {} }
        const result = new Promise<string | null>(resolve => { gate.release = resolve })
        Object.assign(globalThis, { startupResumeGate: gate })
        ipcMain.removeHandler('project:get-resume-id')
        ipcMain.handle('project:get-resume-id', () => {
          gate.entered = true
          return result
        })
      })
      await page.goto(startupUrl.toString())
      await expect.poll(() => app!.evaluate(() => (globalThis as any).startupResumeGate.entered)).toBe(true)
      await expect(splash).toBeVisible()
      await expect(splash.getByRole('img', { name: 'Ambio' })).toBeVisible()
      await expect(launcher).toBeHidden()
      await expect(workbench).toBeHidden()

      await app.evaluate((_, id) => (globalThis as any).startupResumeGate.release(id), resumeId)
      await expect(resumeId ? workbench : launcher).toBeVisible()
      await expect(splash).toBeHidden()
    }
  } finally { await app?.close(); rmSync(home, { recursive: true, force: true }) }
})
