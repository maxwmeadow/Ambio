import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'
import { skipAgentGuides } from './agentGuides'
import { canvasViewportSettled } from './canvasComponentCounts'

test('sticky notes share text with agents, preserve drafts, and persist geometry on Floor and sheets', async () => {
  test.setTimeout(120000)
  const harness = await startHarness({ workspaceId: 'demo' })
  const home = mkdtempSync(join(tmpdir(), 'ambio-notes-home-'))
  mkdirSync(join(home, '.ambio'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  writeFileSync(join(home, '.ambio', 'projects.json'), JSON.stringify([{ id: 'demo', name: 'Notes lab', rootPath: harness.projectDir, ignoredPaths: [], languageOverrides: {}, layoutPreferences: { zoom: 1, panX: 0, panY: 0 }, openedAt: 1 }]))
  const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env
  let app
  try {
    const sheet = await (await harnessFetch(`${harness.apiBase}/api/sheets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'demo', name: 'Note sheet', kind: 'structure' }) })).json()
    app = await electron.launch({ args: ['.'], env: { ...env, AMBIO_E2E: '1', HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') } })
    const page = await app.firstWindow()
    await skipAgentGuides(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.route(/^http:\/\/127\.0\.0\.1:774[34]\//, async route => {
      const url = new URL(route.request().url())
      try {
        const response = await route.fetch({ url: `${harness.apiBase}${url.pathname}${url.search}`, headers: { ...route.request().headers(), Authorization: 'Bearer ambio-isolated-test-token-for-mcp-harness' } })
        await route.fulfill({ response })
      } catch (error) { if (!/disposed|has been closed/.test(String(error))) throw error }
    })
    await page.reload()
    await expect(page.locator('.react-flow__node').first()).toBeAttached()
    await expect(page.locator('.layout-transition')).toHaveCount(0)
    const command = id => page.evaluate(id => window.dispatchEvent(new CustomEvent('ambio:command', { detail: id })), id)
    const read = async surface => (await harnessFetch(`${harness.apiBase}/api/annotations?workspace=demo&sheet=${surface}`)).json()
    const publish = note => page.evaluate(note => window.__ambioGraphStore.getState().applyDbPatch({ type: 'annotation:upserted', payload: note }), note)

    await expect.poll(() => page.evaluate(canvasViewportSettled)).toBe(true)
    await command('map.addNote')
    const card = page.locator('.react-flow__node-note').first()
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Edit note', exact: true }).click()
    await card.getByRole('textbox', { name: 'Note text' }).fill('Why this boundary exists\nKeep the evaluator independent.\n' + Array.from({ length: 30 }, (_, i) => `Explanation ${i + 1}`).join('\n'))
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await read('floor'))[0]?.body).toContain('Keep the evaluator')
    const body = card.locator('.canvas-note__body')
    const camera = await page.locator('.react-flow__viewport').getAttribute('style')
    await body.hover(); await page.mouse.wheel(0, 300)
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await body.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.mouse.wheel(0, 300)
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(camera)
    let floor = (await read('floor'))[0]
    expect(floor.author).toBe('user')
    const originalWidth = (await card.boundingBox()).width
    const resizedByAgent = await harness.client.callTool('edit_sheet', { op: 'edit_note', sheet: 'floor', noteId: floor.id, revision: floor.revision, width: 320, height: 210 })
    expect(resizedByAgent.isError, resizedByAgent.text).toBe(false)
    await publish(resizedByAgent.payload)
    await expect.poll(async () => (await card.boundingBox()).width).toBeGreaterThan(originalWidth)
    floor = (await read('floor'))[0]
    const beforeLayout = await page.evaluate(() => JSON.stringify(window.__ambioGraphStore.getState().floorLayouts))
    // Switching from a code selection to a note drag must leave code alone.
    await page.evaluate(() => { const graph = window.__ambioGraphStore.getState(); graph.setSelectedNode(graph.systems[0].id) })
    await expect(page.locator('.react-flow__node.selected:not(.react-flow__node-note)')).toHaveCount(1)
    const header = await card.locator('.canvas-note__header').boundingBox()
    await page.mouse.move(header.x + 25, header.y + header.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.down(); await page.mouse.move(header.x + 105, header.y + header.height / 2 + 45, { steps: 12 }); await page.mouse.up()
    await page.keyboard.up('Control')
    await expect(page.locator('.react-flow__node.selected:not(.react-flow__node-note)')).toHaveCount(0)
    await expect.poll(async () => (await read('floor'))[0]?.positionX).not.toBe(floor.positionX)
    floor = (await read('floor'))[0]
    const handle = page.locator(`.ambio-node-resizer[data-node-id="note:${floor.id}"] [data-resize-direction="bottom-right"]`)
    await expect(handle).toBeVisible()
    const box = await handle.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 50, { steps: 12 }); await page.mouse.up()
    await expect.poll(async () => (await read('floor'))[0]?.width).toBeGreaterThan(floor.width)
    expect(await page.evaluate(() => JSON.stringify(window.__ambioGraphStore.getState().floorLayouts))).toBe(beforeLayout)
    floor = (await read('floor'))[0]

    await card.getByRole('button', { name: 'Edit note', exact: true }).click()
    const editor = card.getByRole('textbox', { name: 'Note text' })
    await editor.fill('My unsaved clarification')
    const agent = await harness.client.callTool('edit_sheet', { op: 'edit_note', sheet: 'floor', noteId: floor.id, revision: floor.revision, body: 'Agent clarification' })
    expect(agent.isError, agent.text).toBe(false)
    await publish(agent.payload)
    await expect(editor).toHaveValue('My unsaved clarification')
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(card.getByText('Use latest text', { exact: true })).toBeVisible()
    await expect(editor).toHaveValue('My unsaved clarification')
    expect((await read('floor'))[0].body).toBe('Agent clarification')
    await card.getByRole('button', { name: 'Use latest text', exact: true }).click()
    await expect(editor).toHaveValue('Agent clarification')
    await editor.fill('Human and agent agree')
    await editor.press('ControlOrMeta+Enter')
    await expect.poll(async () => (await read('floor'))[0]?.body).toBe('Human and agent agree')

    await card.getByRole('button', { name: 'Edit note', exact: true }).click()
    await card.getByRole('textbox', { name: 'Note text' }).fill('Recovered explanation')
    const current = (await read('floor'))[0]
    const removed = await harness.client.callTool('edit_sheet', { op: 'delete_note', sheet: 'floor', noteId: current.id, revision: current.revision })
    expect(removed.isError, removed.text).toBe(false)
    await page.evaluate(id => window.__ambioGraphStore.getState().applyDbPatch({ type: 'annotation:deleted', payload: { id, workspaceId: 'demo' } }), current.id)
    await expect(card.getByRole('textbox', { name: 'Note text' })).toHaveValue('Recovered explanation')
    await card.getByRole('button', { name: 'Save as new note', exact: true }).click()
    await expect.poll(async () => (await read('floor'))[0]?.body).toBe('Recovered explanation')
    expect((await read('floor'))[0].id).not.toBe(current.id)
    await page.getByText('Note sheet', { exact: true }).click()
    await expect(page.locator('.ambio-sheet-palette')).toBeVisible()
    await expect(card.getByRole('button', { name: 'Edit note', exact: true })).toHaveCount(0)
    await page.locator('.ambio-sheet-palette').getByRole('button', { name: 'Add Note', exact: true }).click()
    const canvas = await page.locator('.react-flow').boundingBox()
    await page.mouse.click(canvas.x + canvas.width - 300, canvas.y + 300)
    await expect.poll(async () => (await read(sheet.id)).length).toBe(1)
    const sheetNote = (await read(sheet.id))[0]
    const sheetCard = page.locator(`.react-flow__node[data-id="note:${sheetNote.id}"]`)
    await sheetCard.getByRole('button', { name: 'Edit note', exact: true }).click()
    await sheetCard.getByRole('textbox', { name: 'Note text' }).fill('Only on this proposal')
    await sheetCard.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await read(sheet.id))[0]?.body).toBe('Only on this proposal')
    await page.screenshot({ path: 'test-results/sticky-notes-sheet.png' })
    await page.reload()
    await expect(page.getByText('Recovered explanation', { exact: true })).toBeVisible()
    await page.getByText('Note sheet', { exact: true }).click()
    await expect(page.locator('.canvas-note__body').getByText('Only on this proposal', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Expand Note sheet', exact: true }).click()
    await page.locator('.ambio-sheet-tree__note', { hasText: 'Only on this proposal' }).click()
    await expect(page.locator(`.react-flow__node[data-id="note:${sheetNote.id}"]`)).toHaveClass(/selected/)
    const reopened = page.locator(`.react-flow__node[data-id="note:${sheetNote.id}"]`)
    await reopened.getByRole('button', { name: 'Delete note', exact: true }).click()
    await expect(reopened).toHaveCount(0)
    expect(await read(sheet.id)).toEqual([])
    expect((await read('floor'))[0].body).toBe('Recovered explanation')
  } finally {
    try { await app?.close() } finally { await harness.stop(); rmSync(home, { recursive: true, force: true }) }
  }
})
