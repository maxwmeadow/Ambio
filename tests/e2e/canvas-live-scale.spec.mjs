import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'
import { canvasComponentCounts } from './canvasComponentCounts'
import { execFileSync } from 'node:child_process'

test('real indexing, snapshot load and watched edits reach a bounded interactive canvas', async () => {
  test.skip(process.env.AMBIO_LIVE_SCALE !== '1', 'Set AMBIO_LIVE_SCALE=1 for isolated real-daemon acceptance')
  test.setTimeout(180000)
  const home = mkdtempSync(join(tmpdir(), 'ambio-live-scale-'))
  const projectDir = join(home, 'project'), appData = join(home, 'AppData', 'Roaming'), localData = join(home, 'AppData', 'Local')
  mkdirSync(projectDir); mkdirSync(appData, { recursive: true }); mkdirSync(localData, { recursive: true })
  const groupSize = 16
  const production = process.env.AMBIO_LIVE_CORPUS === 'ambio'
  const sources = production ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'archd-go', 'mcp'], { encoding: 'utf8' }).split(/\r?\n/)
    .filter(path => /\.(ts|tsx|go|py|js|mjs)$/.test(path) && !/(?:\.test\.|\.spec\.|_test\.go|testdata\/|e2e\/)/.test(path)).slice(0, 512) : []
  const count = production ? sources.length : 512
  if (production) {
    expect(count).toBeGreaterThanOrEqual(256)
    for (const path of sources) {
      const target = join(projectDir, path)
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(resolve(path)))
    }
  } else for (let i = 0; i < count; i++) {
    const folder = join(projectDir, `feature-${Math.floor(i / groupSize)}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `module-${i}.ts`), `${i % groupSize ? `import { value as previous } from './module-${i - 1}'\n` : ''}export const value = ${i % groupSize ? 'previous + 1' : i}\n`)
  }
  let harness, app
  try {
    const started = performance.now()
    harness = await startHarness({ workspaceId: 'live-scale', projectDir, minFiles: count })
    const harnessReadyMs = performance.now() - started
    for (let offset = 0; offset < count; offset += groupSize) {
      const created = await harness.client.callTool('edit_systems', { op: 'create', name: `Feature ${offset / groupSize}` })
      expect(created.isError, created.text).toBe(false)
      const systemId = created.payload.systemId ?? created.payload.id
      const assigned = await harness.client.callTool('edit_systems', { op: 'assign', systemId,
        fileIds: (production ? harness.snapshot.files.slice(offset, offset + groupSize)
          : harness.snapshot.files.filter(file => file.relPath.startsWith(`feature-${offset / groupSize}/`))).map(file => file.id) })
      expect(assigned.isError, assigned.text).toBe(false)
    }
    const snapshotStarted = performance.now()
    const snapshotResponse = await harnessFetch(`${harness.apiBase}/api/snapshot/${harness.workspaceId}`)
    const body = await snapshotResponse.text(), snapshotHttpMs = performance.now() - snapshotStarted
    const snapshot = JSON.parse(body), authored = snapshot.systems.filter(system => ['user', 'agent'].includes(system.source))
    expect(snapshot.files.length).toBe(count)
    expect(authored.length).toBe(Math.ceil(count / groupSize))
    const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
    app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home,
      APPDATA: appData, LOCALAPPDATA: localData, AMBIO_E2E: '1', AMBIO_E2E_HOME: '1' } })
    const page = await app.firstWindow()
    page.on('pageerror', error => console.log('LIVE_PAGE_ERROR', error.message))
    await page.waitForURL(/e2e=1/); await page.setViewportSize({ width: 1400, height: 900 })
    // Use real HTTP and WebSocket listeners with only this isolated harness's
    // public test token. No response bodies or socket messages are mocked.
    await app.evaluate(({ BrowserWindow, session, ipcMain }, endpoints) => {
      session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.url.startsWith(endpoints.api) || details.url.startsWith(endpoints.ws.replace('/ws', '')) || details.url.startsWith(endpoints.ws.replace('ws:', 'http:').replace('/ws', ''))) {
          details.requestHeaders.Authorization = 'Bearer ambio-isolated-test-token-for-mcp-harness'
        }
        callback({ requestHeaders: details.requestHeaders })
      })
      const ports = { api: Number(new URL(endpoints.api).port), ws: Number(new URL(endpoints.ws).port), runtime: 0 }
      ipcMain.removeAllListeners('archd:ports-sync')
      ipcMain.on('archd:ports-sync', event => { event.returnValue = ports })
      BrowserWindow.getAllWindows()[0].webContents.send('archd:ports', ports)
    }, { api: harness.apiBase, ws: harness.wsUrl })
    const floorUrl = new URL(page.url()); floorUrl.searchParams.delete('home'); await page.goto(floorUrl.toString())
    await page.waitForFunction(() => Boolean(window.__ambioGraphStore))
    const platformCount = (snapshot.infraNodes ?? []).filter(node => (node.status ?? 'confirmed') === 'confirmed' && node.category === 'platform').length
    const loadingStarted = performance.now()
    await page.evaluate(({ workspaceId, projectDir, wsUrl }) => {
      const w = window
      w.__ambioPerfTrace.start()
      w.__ambioGraphStore.getState().setCurrentProject({ id: workspaceId, name: 'Live scale fixture', rootPath: projectDir,
        workbenchOpenedAt: Date.now(), reviewCompletedAt: Date.now(), ignoredPaths: [] })
      w.__ambioConnectToArchd(wsUrl)
    }, { workspaceId: harness.workspaceId, projectDir, wsUrl: harness.wsUrl })
    await page.waitForFunction(count => window.__ambioGraphStore.getState().files.length === count, count)
    await expect(page.locator('.ambio-canvas-preparation')).toHaveCount(0, { timeout: 30000 })
    await expect.poll(() => page.evaluate(canvasComponentCounts)).toMatchObject({ canonicalNodes: count + authored.length + platformCount })
    const snapshotToPreparedMs = performance.now() - loadingStarted
    const navigate = async file => {
      await page.keyboard.press('ControlOrMeta+K')
      await page.getByRole('textbox', { name: 'Search the map' }).fill(file.relPath)
      await page.getByRole('option').first().click()
      await expect(page.locator(`.react-flow__node[data-id="${file.id}"]`)).toBeVisible()
    }
    await navigate(snapshot.files[0])
    const components = await page.evaluate(canvasComponentCounts)
    expect(components.flowNodes).toBeLessThan(100)
    expect(components.wrappers).toBeGreaterThan(0)
    const edited = snapshot.files[0]
    writeFileSync(edited.path, `${readFileSync(edited.path, 'utf8')}\n// watched edit\n// another indexed line\n`)
    await expect.poll(() => page.evaluate(id => window.__ambioGraphStore.getState().files.find(file => file.id === id)?.lineCount, edited.id),
      { timeout: 20000 }).toBeGreaterThan(edited.lineCount)
    try { await expect(page.locator('.ambio-canvas-preparation')).toHaveCount(0, { timeout: 20000 }) } catch (error) {
      console.log('LIVE_PENDING_DIAGNOSTIC', JSON.stringify(await page.evaluate(() => ({ stages: window.__ambioPerfTrace.summary(),
        files: window.__ambioGraphStore.getState().files.length, layouts: window.__ambioGraphStore.getState().floorLayouts.length }))))
      throw error
    }
    for (let i = 0; i < 6; i++) await navigate(snapshot.files[(i * 83) % count])
    const stages = await page.evaluate(() => window.__ambioPerfTrace.summary())
    expect(stages.stages['worker.geometry-post'].count).toBeLessThanOrEqual(8)
    console.log('CANVAS_LIVE_SCALE', JSON.stringify({ corpus: production ? `${count} copied Ambio production sources; synthetic 16-file boundaries` : 'generated TypeScript modules',
      files: count, authoredSystems: authored.length, indexedLines: snapshot.files.reduce((sum, file) => sum + file.lineCount, 0),
      dependencies: (snapshot.dependencies ?? []).length, harnessReadyMs,
      snapshotHttpMs, snapshotBytes: Buffer.byteLength(body), snapshotToPreparedMs,
      components: await page.evaluate(canvasComponentCounts), stages,
      realHttp: true, realWebSocket: true, watchedEditObserved: true }))
  } finally {
    await app?.close(); harness?.stop()
    if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('ambio-live-scale-')) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
