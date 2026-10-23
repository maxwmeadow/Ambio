import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { canvasScaleFixture } from '../fixtures/canvasScale'
import { canvasComponentCounts } from './canvasComponentCounts'

async function launchScene() {
  const home = mkdtempSync(join(tmpdir(), 'ambio-scene-test-'))
  const appData = join(home, 'AppData', 'Roaming'), localData = join(home, 'AppData', 'Local')
  mkdirSync(appData, { recursive: true }); mkdirSync(localData, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, HOME: home, USERPROFILE: home,
    APPDATA: appData, LOCALAPPDATA: localData, AMBIO_E2E: '1' } })
  const page = await app.firstWindow()
  await page.waitForURL(/e2e=1/)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, route => route.fulfill({ json: [] }))
  await page.addInitScript(() => {
    const w = window as any, NativeWorker = window.Worker
    w.__sceneWorkers = []; w.__sceneMessages = []; w.__sceneTerminations = 0
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args); w.__sceneWorkers.push(this)
        this.addEventListener('message', event => {
          if (event.data.op === 'prepared' && event.data.token === w.__holdPreparationToken) {
            event.stopImmediatePropagation(); w.__heldPreparation = { worker: this, data: event.data }
          }
        })
      }
      terminate() { w.__sceneTerminations++; return super.terminate() }
      postMessage(message: any, options?: any) {
        if (message.op === 'prepare' && message.input.systems.length + message.input.files.length === 100000) w.__holdPreparationToken = message.token
        w.__sceneMessages.push({ op: message.op, channel: message.channel,
          items: message.input ? message.input.systems.length + message.input.files.length + message.input.infraNodes.length : 0 })
        return super.postMessage(message, options)
      }
    }
  })
  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).__ambioGraphStore))
  return { app, page, async close() {
    await app.close()
    if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('ambio-scene-test-')) rmSync(home, { recursive: true, force: true })
  } }
}

test('a superseded preparation cannot overwrite a newer workspace or adopt the complete project', async () => {
  test.setTimeout(90_000)
  const fixture = await launchScene(), { page } = fixture
  try {
    const first = canvasScaleFixture({ entities: 100000, saved: true })
    await page.evaluate(snapshot => (window as any).__ambioGraphStore.getState().applySnapshot(snapshot), first)
    await page.waitForFunction(() => Boolean((window as any).__heldPreparation))
    const latest = canvasScaleFixture({ entities: 1200, saved: true })
    latest.systems[0].name = 'Latest workspace boundary'
    await page.evaluate(snapshot => {
      const graph = (window as any).__ambioGraphStore
      graph.getState().setCurrentProject({ ...graph.getState().currentProject, id: 'latest-workspace' })
      graph.getState().applySnapshot(snapshot)
    }, latest)
    await expect(page.locator('.ambio-canvas-preparation')).toHaveCount(0, { timeout: 20000 })
    await expect.poll(() => page.evaluate(canvasComponentCounts)).toMatchObject({ canonicalNodes: 1200 })
    expect(await page.evaluate(() => (window as any).__sceneTerminations > 0 || (window as any).__sceneMessages.some((m: any) => m.op === 'cancel-prepare'))).toBe(true)
    await page.evaluate(() => { const w = window as any; w.__holdPreparationToken = null;
      w.__heldPreparation.worker.dispatchEvent(new MessageEvent('message', { data: w.__heldPreparation.data })); w.__heldPreparation = null })
    await page.keyboard.press('ControlOrMeta+K')
    await page.getByRole('textbox', { name: 'Search the map' }).fill(latest.files[0].relPath)
    await page.getByRole('option').first().click()
    await expect(page.locator(`.react-flow__node[data-id="${latest.files[0].id}"]`)).toBeVisible()
    const components = await page.evaluate(canvasComponentCounts)
    expect(components.flowNodes).toBeLessThan(100)
    expect(components.canonicalNodes).toBe(1200)
  } finally { await fixture.close() }
})

test('a large worker failure retains the scene and Retry prepares the latest model', async () => {
  test.setTimeout(90_000)
  const fixture = await launchScene(), { page } = fixture
  try {
    await page.evaluate(snapshot => (window as any).__ambioGraphStore.getState().applySnapshot(snapshot), canvasScaleFixture({ entities: 3000, saved: true }))
    await expect(page.locator('.ambio-canvas-preparation')).toHaveCount(0, { timeout: 20000 })
    await expect.poll(() => page.evaluate(canvasComponentCounts)).toMatchObject({ canonicalNodes: 3000 })
    const before = await page.locator('.react-flow__node').count()
    expect(before).toBeGreaterThan(0)
    await page.evaluate(() => (window as any).__sceneWorkers.at(-1).dispatchEvent(new ErrorEvent('error', { message: 'fixture worker crash' })))
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(0)
    await page.evaluate(snapshot => (window as any).__ambioGraphStore.getState().applySnapshot(snapshot), canvasScaleFixture({ entities: 4000, saved: true }))
    await expect(page.locator('.ambio-canvas-preparation')).toContainText('Retry')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('.ambio-canvas-preparation')).toHaveCount(0, { timeout: 20000 })
    await expect.poll(() => page.evaluate(canvasComponentCounts)).toMatchObject({ canonicalNodes: 4000 })
    expect(await page.evaluate(() => (window as any).__sceneWorkers.length)).toBeGreaterThan(1)
  } finally { await fixture.close() }
})

test('a failed initial layout save cannot create a preparation and network retry loop', async () => {
  const fixture = await launchScene(), { page } = fixture
  try {
    let requests = 0, available = false
    await page.route(/\/api\/layout\/batch$/, async route => {
      if (route.request().postDataJSON().workspaceId === 'save-failure') requests++
      await route.fulfill({ status: available ? 200 : 503, json: available ? { layouts: [] } : { error: 'fixture offline' } })
    })
    await page.evaluate(snapshot => {
      const graph = (window as any).__ambioGraphStore
      graph.getState().setCurrentProject({ ...graph.getState().currentProject, id: 'save-failure' })
      graph.getState().applySnapshot(snapshot)
    }, canvasScaleFixture({ entities: 80, saved: false }))
    await expect(page.getByText('Could not save the map layout', { exact: true })).toBeVisible()
    await page.waitForTimeout(800)
    expect(requests).toBe(1)
    available = true
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => requests).toBe(2)
    await expect(page.getByText('Could not save the map layout', { exact: true })).toHaveCount(0)
    await expect(page.locator('.react-flow__node').first()).toBeAttached()
  } finally { await fixture.close() }
})

test('switching to an empty workspace clears old interaction nodes and pending navigation', async () => {
  const fixture = await launchScene(), { page } = fixture
  try {
    await page.evaluate(snapshot => (window as any).__ambioGraphStore.getState().applySnapshot(snapshot), canvasScaleFixture({ entities: 1000, saved: true }))
    await expect(page.locator('.ambio-canvas-preparation')).toHaveCount(0)
    await page.evaluate(() => {
      const graph = (window as any).__ambioGraphStore
      graph.getState().setCurrentProject({ ...graph.getState().currentProject, id: 'empty-workspace' })
    })
    await expect(page.locator('.react-flow__node')).toHaveCount(0)
    await expect.poll(() => page.evaluate(canvasComponentCounts)).toMatchObject({ canonicalNodes: 0, flowNodes: 0 })
  } finally { await fixture.close() }
})
