import { _electron as electron, expect, test } from '@playwright/test'
import { canvasViewportSettled } from './canvasComponentCounts'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'

// A sheet drop is projected by the scene worker. Until that projection lands
// the prepared nodes still hold the pre-drag layout; releasing the drag
// snapshot at pointer-up showed them, so the node snapped back to where the
// drag began and then animated to the drop.
test('a node released on a sheet stays where it was dropped', async () => {
  test.setTimeout(90_000)
  const harness = await startHarness({ workspaceId: 'demo' })
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  let app
  try {
    const response = await harnessFetch(`${harness.apiBase}/api/sheets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'demo', name: 'Release lab', kind: 'structure' }),
    })
    expect(response.ok).toBe(true)
    const sheet = await response.json()
    const readSheet = async () => (await harnessFetch(`${harness.apiBase}/api/sheets/${sheet.id}?workspace=demo`)).json()
    app = await electron.launch({ args: ['.'], env: { ...env, AMBIO_E2E: '1' } })
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      try {
        const result = await route.fetch({ url: `${harness.apiBase}${url.pathname}${url.search}`,
          headers: { ...route.request().headers(), Authorization: 'Bearer ambio-isolated-test-token-for-mcp-harness' } })
        await route.fulfill({ response: result })
      } catch (error) {
        // page.reload() cancels requests still in flight; only that is expected.
        if (!/disposed|has been closed/.test(String(error))) throw error
      }
    })
    await page.reload()
    await expect(page.locator('.react-flow__node').first()).toBeAttached()
    await page.getByText('Release lab', { exact: true }).click()
    const palette = page.locator('.ambio-sheet-palette')
    await expect(palette).toBeVisible()
    await page.waitForFunction(canvasViewportSettled, undefined, { polling: 'raf' })

    // A blank point with room around it, so the drop lands on empty canvas.
    const blankPoint = () => page.evaluate(() => {
      const canvas = document.querySelector('.react-flow').getBoundingClientRect()
      const boxes = [...document.querySelectorAll('.react-flow__node')].map(node => node.getBoundingClientRect())
      for (let y = canvas.top + 150; y < canvas.bottom - 150; y += 40) {
        for (let x = canvas.right - 250; x > canvas.left + 250; x -= 40) {
          if (boxes.every(box => x < box.left - 150 || x > box.right + 150 || y < box.top - 150 || y > box.bottom + 150)) return { x, y }
        }
      }
      throw new Error('No blank canvas point')
    })
    const point = await blankPoint()
    const canvas = page.locator('.react-flow')
    const box = await canvas.boundingBox()
    await palette.getByRole('button', { name: 'Add File', exact: true }).dragTo(canvas, {
      targetPosition: { x: point.x - box.x, y: point.y - box.y },
    })
    await expect.poll(async () => ((await readSheet()).planned ?? []).length).toBe(1)
    const id = `planned:${(await readSheet()).planned[0].id}`
    const node = page.locator(`.react-flow__node[data-id="${id}"]`)
    await expect(node).toBeVisible()
    // A new node animates into place; drag from where it settles.
    let previous = null
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await node.boundingBox()
      if (previous && Math.abs(current.x - previous.x) < 0.5 && Math.abs(current.y - previous.y) < 0.5) break
      previous = current
      await page.waitForTimeout(100)
    }
    const from = await page.evaluate(id => {
      const box = document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect()
      for (const fy of [0.75, 0.5, 0.25]) {
        for (const fx of [0.3, 0.7, 0.5]) {
          const x = box.x + box.width * fx, y = box.y + box.height * fy
          const hit = document.elementFromPoint(x, y)
          if (hit?.closest('.react-flow__node')?.getAttribute('data-id') === id &&
            !hit.closest('.nodrag, .ambio-floating-resize-handle')) return { x, y }
        }
      }
      throw new Error(`No draggable point on ${id}`)
    }, id)

    const origin = previous
    for (const delta of [{ x: -90, y: 70 }, { x: 80, y: -60 }]) {
      const start = await node.boundingBox()
      const grab = { x: from.x + start.x - origin.x, y: from.y + start.y - origin.y }
      await page.mouse.move(grab.x, grab.y)
      await page.mouse.down()
      await page.mouse.move(grab.x + delta.x, grab.y + delta.y, { steps: 20 })
      await page.waitForTimeout(150)
      const released = await node.boundingBox()
      // Sample every frame from pointer-up until the drop has settled.
      await page.evaluate(id => {
        window.__releaseSamples = []
        const began = performance.now()
        const tick = () => {
          const rect = document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect()
          if (rect) window.__releaseSamples.push({ x: rect.x, y: rect.y })
          if (performance.now() - began < 1200) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }, id)
      await page.mouse.up()
      await page.waitForTimeout(1400)
      const samples = await page.evaluate(() => window.__releaseSamples)
      expect(samples.length).toBeGreaterThan(10)
      for (const sample of samples) {
        // Any settling after the drop is a few pixels; the snap-back was the
        // whole drag distance.
        expect(Math.hypot(sample.x - released.x, sample.y - released.y)).toBeLessThan(20)
      }
      await expect.poll(async () => {
        const layout = (await readSheet()).layouts.find(row => row.nodeId === id)
        return layout ? Math.round(layout.positionX) : null
      }).not.toBeNull()
    }
  } finally {
    try { await app?.close() } finally { harness.stop() }
  }
})
