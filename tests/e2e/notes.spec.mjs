import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness, harnessFetch } from '../../mcp/e2e/mcpHarness.mjs'
import { skipAgentGuides } from './agentGuides'
import { canvasViewportSettled } from './canvasComponentCounts'

test('notes autosave, nest, compress and persist through native Floor and sheet layouts', async () => {
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
    const createdOwner = await harness.client.callTool('edit_systems', { op: 'create', name: 'Note owner' })
    expect(createdOwner.isError, createdOwner.text).toBe(false)
    const ownerId = createdOwner.payload.systemId ?? createdOwner.payload.id
    expect(ownerId).toBeTruthy()
    const ownerLayout = { nodeId: ownerId, nodeType: 'system', parentNodeId: null, parentNodeType: null, containmentKind: 'root', positionX: 0, positionY: 0, width: 620, height: 420, scale: 1, interiorScale: 1 }
    const placed = await harnessFetch(`${harness.apiBase}/api/layout/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'demo', layouts: [ownerLayout] }) })
    expect(placed.ok, await placed.clone().text()).toBe(true)
    const read = async surface => (await harnessFetch(`${harness.apiBase}/api/annotations?workspace=demo&sheet=${surface}`)).json()
    const nativeScene = async () => {
      const snapshot = await (await harnessFetch(`${harness.apiBase}/api/snapshot/demo`)).json()
      await page.evaluate(({ snapshot, ownerId }) => window.__ambioGraphStore.setState({ systems: snapshot.systems.filter(system => system.id === ownerId), files: [], infraNodes: [], dependencies: [], floorLayouts: snapshot.floorLayouts ?? [] }), { snapshot, ownerId })
      await expect(page.locator(`.react-flow__node[data-id="${ownerId}"]`)).toBeVisible()
      await expect.poll(() => page.evaluate(canvasViewportSettled)).toBe(true)
    }
    const command = id => page.evaluate(id => window.dispatchEvent(new CustomEvent('ambio:command', { detail: id })), id)
    const publish = note => page.evaluate(note => window.__ambioGraphStore.getState().applyDbPatch({ type: 'annotation:upserted', payload: note }), note)
    await page.reload(); await nativeScene()
    const owner = page.locator(`.react-flow__node[data-id="${ownerId}"]`)
    const noteCard = id => page.locator(`.react-flow__node[data-id="note:${id}"]`)
    const edit = async (id, body) => {
      const card = noteCard(id)
      await card.locator('.canvas-note__body').dblclick()
      await card.getByRole('textbox', { name: 'Note text' }).fill(body)
      await expect.poll(async () => (await read('floor')).find(note => note.id === id)?.body).toBe(body)
      await card.getByRole('textbox', { name: 'Note text' }).press('Escape')
    }
    const dragInside = async (id, surface) => {
      const card = noteCard(id)
      const header = await card.locator('.canvas-note__header').boundingBox()
      const box = await owner.boundingBox()
      await page.mouse.move(header.x + 20, header.y + header.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * .3, box.y + box.height * .6, { steps: 16 })
      await page.mouse.up()
      await expect.poll(async () => {
        const row = (await read(surface)).find(note => note.id === id)
        return row?.layout?.parentNodeId
      }).toBe(ownerId)
      await expect.poll(() => page.evaluate(canvasViewportSettled)).toBe(true)
    }
    await command('map.addNote')
    await expect.poll(async () => (await read('floor')).length).toBe(1)
    let first = (await read('floor'))[0]
    await expect(noteCard(first.id).getByRole('button')).toHaveCount(0)
    await edit(first.id, 'Live notes need no form controls')
    await dragInside(first.id, 'floor')
    let secondId
    for (let index = 0; index < 2; index++) {
      await command('map.addNote')
      await expect.poll(async () => (await read('floor')).length).toBe(index + 2)
      const latest = (await read('floor')).find(note => ![first.id, ...(index ? [secondId] : [])].includes(note.id))
      if (!index) secondId = latest.id
      await dragInside(latest.id, 'floor')
    }
    const notes = await read('floor')
    expect(notes.every(note => note.layout?.parentNodeId === ownerId)).toBe(true)
    const compressed = await page.evaluate(id => window.__ambioGraphStore.getState().floorLayouts.find(row => row.nodeId === id), ownerId)
    expect(compressed.interiorScale).toBeLessThan(1)
    const boxes = await Promise.all(notes.map(note => noteCard(note.id).boundingBox()))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1).toBe(true)
    }
    // Pulling out restores a root frame; returning uses native collision again.
    const source = await noteCard(first.id).locator('.canvas-note__header').boundingBox()
    const canvas = await page.locator('.react-flow').boundingBox()
    await page.mouse.move(source.x + 20, source.y + source.height / 2)
    await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width - 140, canvas.y + canvas.height - 130, { steps: 16 }); await page.mouse.up()
    await expect.poll(async () => (await read('floor')).find(note => note.id === first.id)?.layout?.parentNodeId).toBe(null)
    await dragInside(first.id, 'floor')

    // Parent motion carries notes through native parent-relative geometry.
    await page.evaluate(id => window.__ambioGraphStore.getState().setSelectedNode(id), ownerId)
    const before = await noteCard(first.id).boundingBox()
    const parent = await owner.boundingBox()
    await page.mouse.move(parent.x + parent.width * .65, parent.y + 18)
    await page.mouse.down(); await page.mouse.move(parent.x + parent.width * .65 + 65, parent.y + 53, { steps: 12 }); await page.mouse.up()
    await expect.poll(async () => (await noteCard(first.id).boundingBox()).x).not.toBe(before.x)
    expect((await read('floor')).find(note => note.id === first.id).layout.parentNodeId).toBe(ownerId)
    // Standard resize chrome updates the parent and every child in one layout batch.
    const handle = page.locator(`.ambio-node-resizer[data-node-id="${ownerId}"] [data-resize-direction="bottom-right"]`)
    await expect(handle).toBeVisible()
    const resize = await handle.boundingBox()
    const parentBeforeResize = await owner.boundingBox()
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
    await page.mouse.down(); await page.mouse.move(resize.x + resize.width / 2 + 70, resize.y + resize.height / 2 + 50, { steps: 12 }); await page.mouse.up()
    await expect.poll(async () => (await owner.boundingBox()).width).toBeGreaterThan(parentBeforeResize.width)
    expect((await read('floor')).every(note => note.layout.parentNodeId === ownerId)).toBe(true)
    await edit(first.id, '')
    await edit(first.id, 'Text before concurrent editing')
    // Concurrent agent text cannot overwrite an unsaved human edit.
    first = (await read('floor')).find(note => note.id === first.id)
    await noteCard(first.id).locator('.canvas-note__body').dblclick()
    const editor = noteCard(first.id).getByRole('textbox', { name: 'Note text' })
    let releaseDraft
    const agentApplied = new Promise(resolve => { releaseDraft = resolve })
    await page.route(url => url.pathname === `/api/annotations/${first.id}`, async route => {
      if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.body === 'My draft') await agentApplied
      await route.fallback()
    })
    await editor.fill('My draft')
    const agent = await harness.client.callTool('edit_sheet', { op: 'edit_note', sheet: 'floor', noteId: first.id, revision: first.revision, body: 'Agent text' })
    expect(agent.isError, agent.text).toBe(false); await publish(agent.payload); releaseDraft()
    await expect(editor).toHaveValue('My draft')
    await expect(noteCard(first.id).getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible()
    await noteCard(first.id).getByRole('button', { name: 'Keep my text', exact: true }).click()
    await expect.poll(async () => (await read('floor')).find(note => note.id === first.id)?.body).toBe('My draft')
    await editor.press('Escape')
    await page.getByText('Note sheet', { exact: true }).click()
    await expect(page.locator('.ambio-sheet-palette')).toBeVisible()
    await page.locator('.ambio-sheet-palette').getByRole('button', { name: 'Add Note', exact: true }).click()
    const target = await owner.boundingBox()
    await page.mouse.click(target.x + target.width * .7, target.y + target.height * .7)
    await expect.poll(async () => (await read(sheet.id)).length).toBe(1)
    const sheetNote = (await read(sheet.id))[0]
    await expect.poll(async () => (await read(sheet.id))[0]?.layout?.parentNodeId).toBe(ownerId)
    await noteCard(sheetNote.id).locator('.canvas-note__body').dblclick()
    await noteCard(sheetNote.id).getByRole('textbox', { name: 'Note text' }).fill('Only this sheet')
    await expect.poll(async () => (await read(sheet.id))[0]?.body).toBe('Only this sheet')
    await noteCard(sheetNote.id).getByRole('textbox', { name: 'Note text' }).press('Escape')
    await page.screenshot({ path: 'test-results/sticky-notes-native.png' })
    await page.reload(); await nativeScene()
    await page.getByText('Note sheet', { exact: true }).click()
    await expect(noteCard(sheetNote.id)).toHaveAttribute('data-id', `note:${sheetNote.id}`)
    await page.evaluate(id => window.__ambioGraphStore.getState().setSelectedNode(`note:${id}`), sheetNote.id)
    await command('view.fitView')
    await expect(noteCard(sheetNote.id)).toBeVisible()
    await noteCard(sheetNote.id).locator('.canvas-note__header').click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await read(sheet.id)).length).toBe(0)
    expect((await read('floor')).length).toBe(3)

  } finally {
    try { await app?.close() } finally { await harness.stop(); rmSync(home, { recursive: true, force: true }) }
  }
})
