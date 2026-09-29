import { _electron as electron, expect, test } from '@playwright/test'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'

for (const creation of ['drag', 'click']) {
  test(`sheet authoring (${creation}) nests new and existing files and keeps the layout after reopening`, async () => {
    test.setTimeout(90_000)
    const harness = await startHarness({ workspaceId: 'demo' })
    const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
    let app
    try {
      const response = await harnessFetch(`${harness.apiBase}/api/sheets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'demo', name: 'Authoring lab', kind: 'structure' }),
      })
      expect(response.ok).toBe(true)
      const sheet = await response.json()
      const readSheet = async () => (await harnessFetch(`${harness.apiBase}/api/sheets/${sheet.id}?workspace=demo`)).json()
      app = await electron.launch({ args: ['.'], env: { ...env, AXIOM_E2E: '1' } })
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
        const url = new URL(route.request().url())
        const result = await route.fetch({ url: `${harness.apiBase}${url.pathname}${url.search}`,
          headers: { ...route.request().headers(), Authorization: 'Bearer axiom-isolated-test-token-for-mcp-harness' } })
        await route.fulfill({ response: result })
      })
      await page.reload()
      await expect(page.locator('.react-flow__node').first()).toBeAttached()
      await expect(page.locator('.layout-transition')).toHaveCount(0)
      await page.getByRole('button', { name: 'Authoring lab STR', exact: true }).click()
      const palette = page.locator('.axiom-sheet-palette')
      await expect(palette).toBeVisible()

      const dropStencil = async (label, point) => {
        const canvas = page.locator('.react-flow')
        const box = await canvas.boundingBox()
        await palette.getByRole('button', { name: `Add ${label}`, exact: true }).dragTo(canvas, {
          targetPosition: { x: point.x - box.x, y: point.y - box.y },
        })
      }
      // Find a visible blank point, away from the palette and the live Floor.
      const blankPoint = () => page.evaluate(() => {
        const canvas = document.querySelector('.react-flow').getBoundingClientRect()
        const boxes = [...document.querySelectorAll('.react-flow__node')].map(node => node.getBoundingClientRect())
        for (let y = canvas.top + 150; y < canvas.bottom - 100; y += 80) {
          for (let x = canvas.right - 200; x > canvas.left + 200; x -= 80) {
            if (boxes.every(box => x < box.left || x > box.right || y < box.top || y > box.bottom)) return { x, y }
          }
        }
        throw new Error('No blank canvas point')
      })
      const point = await blankPoint()
      if (creation === 'drag') await dropStencil('System', point)
      else {
        await page.mouse.click(point.x, point.y)
        await palette.getByRole('button', { name: 'Add System', exact: true }).click()
      }
      await expect.poll(async () => ((await readSheet()).planned ?? []).length).toBe(1)
      const system = (await readSheet()).planned[0]
      expect(system.parentSystemId).toBeNull()
      const systemNode = page.locator(`.react-flow__node[data-id="planned:${system.id}"]`)
      await expect(systemNode).toBeVisible()
      const centerSystem = async () => {
        const box = await systemNode.boundingBox()
        const canvas = await page.locator('.react-flow').boundingBox()
        const shift = { x: canvas.x + canvas.width / 2 - box.x - box.width / 2, y: canvas.y + canvas.height / 2 - box.y - box.height / 2 }
        await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.8)
        await page.mouse.down({ button: 'middle' })
        await page.mouse.move(canvas.x + canvas.width / 2 + shift.x, canvas.y + canvas.height * 0.8 + shift.y, { steps: 15 })
        await page.mouse.up({ button: 'middle' })
      }
      if (creation === 'click') await page.waitForTimeout(500)
      await centerSystem()
      const systemBox = await systemNode.boundingBox()
      await dropStencil('File', { x: systemBox.x + systemBox.width * 0.35, y: systemBox.y + systemBox.height * 0.45 })
      await expect.poll(async () => ((await readSheet()).planned ?? []).length).toBe(2)
      const nestedFile = (await readSheet()).planned.find(node => node.kind === 'file')
      expect(nestedFile.parentSystemId).toBe(`planned:${system.id}`)
      await expect.poll(async () => (await readSheet()).layouts.find(layout => layout.nodeId === `planned:${nestedFile.id}`)?.parentNodeId).toBe(`planned:${system.id}`)

      // A palette click adds to the selected system without a precision drop.
      await systemNode.click({ position: { x: systemBox.width / 2, y: 10 } })
      await palette.getByRole('button', { name: 'Add File', exact: true }).click()
      await expect.poll(async () => ((await readSheet()).planned ?? []).length).toBe(3)
      const clickFile = (await readSheet()).planned.find(node => node.id !== nestedFile.id && node.kind === 'file')
      expect(clickFile.parentSystemId).toBe(`planned:${system.id}`)

      // Create another root file and move it into the same frame using a mouse.
      await dropStencil('File', await blankPoint())
      await expect.poll(async () => ((await readSheet()).planned ?? []).length).toBe(4)
      const rootFile = (await readSheet()).planned.find(node => node.kind === 'file' && node.parentSystemId === null)
      expect(rootFile).toBeTruthy()
      const fileNode = page.locator(`.react-flow__node[data-id="planned:${rootFile.id}"]`)
      await expect(fileNode).toBeVisible()
      const from = await fileNode.boundingBox()
      const to = await systemNode.boundingBox()
      await page.mouse.move(from.x + from.width / 2, from.y + 12)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width * 0.6, to.y + to.height * 0.7, { steps: 20 })
      await page.mouse.up()
      await expect.poll(async () => (await readSheet()).layouts.find(layout => layout.nodeId === `planned:${rootFile.id}`)?.parentNodeId).toBe(`planned:${system.id}`)
      const saved = (await readSheet()).layouts
      await page.reload()
      await page.getByRole('button', { name: 'Authoring lab STR', exact: true }).click()
      await expect(systemNode).toBeAttached()
      await centerSystem()
      const reopenedBox = await systemNode.boundingBox()
      await page.mouse.move(reopenedBox.x + reopenedBox.width / 2, reopenedBox.y + reopenedBox.height / 2)
      for (let index = 0; index < 12; index++) {
        if (await page.locator(`.react-flow__node[data-id="planned:${nestedFile.id}"]`).count()) break
        await page.mouse.wheel(0, -100)
        await page.waitForTimeout(100)
      }
      await page.waitForTimeout(900)
      for (const file of [nestedFile, clickFile, rootFile]) {
        const node = page.locator(`.react-flow__node[data-id="planned:${file.id}"]`)
        await expect(node).toBeAttached()
        const parentBox = await page.locator(`.react-flow__node[data-id="planned:${system.id}"]`).boundingBox()
        const box = await node.boundingBox()
        expect(box.x).toBeGreaterThanOrEqual(parentBox.x)
        expect(box.y).toBeGreaterThanOrEqual(parentBox.y)
        expect(box.x + box.width).toBeLessThanOrEqual(parentBox.x + parentBox.width + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(parentBox.y + parentBox.height + 1)
      }
      // Rename through the inline editors; editing must preserve containment.
      await systemNode.locator('[data-node-editable="true"]').first().dblclick()
      await systemNode.locator('input').fill('Orders')
      await systemNode.locator('input').press('Enter')
      for (const [file, name] of [[nestedFile, 'orders.py'], [clickFile, 'repository.py'], [rootFile, 'handlers.py']]) {
        const node = page.locator(`.react-flow__node[data-id="planned:${file.id}"]`)
        await node.locator('[data-node-editable="true"]').last().dblclick()
        await node.locator('input').fill(name)
        await node.locator('input').press('Enter')
        await expect.poll(async () => (await readSheet()).planned.find(item => item.id === file.id)?.declaredPath).toBe(name)
      }
      expect((await readSheet()).layouts).toEqual(saved)
      await page.screenshot({ path: `test-results/sheet-authoring-${creation}.png` })
    } finally {
      try { await app?.close() } finally { harness.stop() }
    }
  })
}
