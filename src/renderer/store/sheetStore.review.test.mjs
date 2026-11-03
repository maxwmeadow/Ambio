import assert from 'node:assert/strict'
import test from 'node:test'
import { sheetElementHasChange, useSheetStore } from './sheetStore.ts'

test('a decision response normalizes empty daemon collections', async () => {
  const originalFetch = globalThis.fetch
  const sheet = { id: 'empty', workspaceId: 'ws', revision: 1 }
  const layer = { sheet, planned: [], plannedEdges: [], elements: [], annotations: [], layouts: [], removals: [] }
  useSheetStore.setState({ workspaceId: 'ws', activeSheetId: sheet.id, sheets: [sheet], layersById: { empty: layer } })
  globalThis.fetch = async () => Response.json({ sheet: { ...sheet, revision: 2 }, planned: null, plannedEdges: null })
  try {
    await useSheetStore.getState().reviewSheetProposals('ws', sheet.id, 1, [{ kind: 'relationship', id: 'edge' }], 'approved')
    assert.deepEqual(useSheetStore.getState().planned, [])
    assert.deepEqual(useSheetStore.getState().plannedEdges, [])
    assert.equal(useSheetStore.getState().layersById.empty.sheet.revision, 2)
  } finally {
    globalThis.fetch = originalFetch
    useSheetStore.setState({ workspaceId: '', activeSheetId: null, sheets: [], layersById: {}, planned: [], plannedEdges: [] })
  }
})

test('a stale group decision refreshes the visible plan without retrying approval', async () => {
  const originalFetch = globalThis.fetch
  const sheet = { id: 'plan', workspaceId: 'ws', revision: 3 }
  const layer = { sheet, planned: [{ id: 'old', sheetId: sheet.id }], plannedEdges: [], elements: [], annotations: [], layouts: [], removals: [] }
  const latest = { ...layer, sheet: { ...sheet, revision: 4 }, planned: [{ id: 'new', sheetId: sheet.id, approvalStatus: 'pending' }] }
  const requests = []
  useSheetStore.setState({ workspaceId: 'ws', activeSheetId: sheet.id, sheets: [sheet], layersById: { plan: layer } })
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return init?.method === 'POST' ? new Response('The plan changed; review it again', { status: 409 }) : Response.json(latest)
  }
  try {
    await assert.rejects(useSheetStore.getState().reviewSheetProposals('ws', sheet.id, 3, [{ kind: 'addition', id: 'old' }], 'approved'), /plan changed/)
    assert.equal(requests.filter(request => request.init?.method === 'POST').length, 1)
    assert.deepEqual(JSON.parse(requests[0].init.body).choices, [{ kind: 'addition', id: 'old' }])
    assert.equal(useSheetStore.getState().layersById.plan.sheet.revision, 4)
    assert.equal(useSheetStore.getState().planned[0].id, 'new')
    assert.equal(useSheetStore.getState().planned[0].approvalStatus, 'pending')
  } finally {
    globalThis.fetch = originalFetch
    useSheetStore.setState({ workspaceId: '', activeSheetId: null, sheets: [], layersById: {}, planned: [], plannedEdges: [] })
  }
})


test('browsing a sheet loads its contents without changing the active or visible layers', async () => {
  const originalFetch = globalThis.fetch
  const first = { id: 'first', workspaceId: 'ws', revision: 1 }
  const second = { id: 'second', workspaceId: 'ws', revision: 1 }
  const layer = sheet => ({ sheet, planned: [], plannedEdges: [], elements: [], annotations: [], layouts: [], removals: [] })
  useSheetStore.setState({ workspaceId: 'ws', activeSheetId: first.id, visibleSheetIds: [first.id], sheets: [first, second], layersById: { first: layer(first) } })
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json(layer(second)) }
  try {
    await useSheetStore.getState().loadSheetContents('ws', second.id)
    assert.equal(useSheetStore.getState().activeSheetId, first.id)
    assert.deepEqual(useSheetStore.getState().visibleSheetIds, [first.id])
    assert.equal(useSheetStore.getState().layersById.second.sheet.id, second.id)
    await useSheetStore.getState().loadSheetContents('ws', second.id)
    assert.equal(calls, 1)
    await useSheetStore.getState().openSheet('ws', second.id, { exclusive: true })
    assert.deepEqual(useSheetStore.getState().visibleSheetIds, [second.id])
    await useSheetStore.getState().toggleSheetVisibility('ws', first.id)
    assert.equal(useSheetStore.getState().activeSheetId, second.id)
    assert.deepEqual(useSheetStore.getState().visibleSheetIds, [second.id, first.id])
    await useSheetStore.getState().toggleSheetVisibility('ws', second.id)
    assert.equal(useSheetStore.getState().activeSheetId, first.id)
    await useSheetStore.getState().toggleSheetVisibility('ws', first.id)
    assert.equal(useSheetStore.getState().activeSheetId, null)
    assert.deepEqual(useSheetStore.getState().visibleSheetIds, [])
  } finally {
    globalThis.fetch = originalFetch
    useSheetStore.setState({ workspaceId: '', activeSheetId: null, visibleSheetIds: [], sheets: [], layersById: {}, planned: [], plannedEdges: [] })
  }
})

test('late contents loading cannot resurrect a deleted sheet or cross projects', async () => {
  const originalFetch = globalThis.fetch
  const sheet = { id: 'late', workspaceId: 'ws', revision: 1 }
  let respond
  globalThis.fetch = () => new Promise(resolve => { respond = resolve })
  try {
    for (const projectSwitch of [false, true]) {
      useSheetStore.setState({ workspaceId: 'ws', sheets: [sheet], layersById: {} })
      const loading = useSheetStore.getState().loadSheetContents('ws', sheet.id)
      useSheetStore.setState(projectSwitch ? { workspaceId: 'other' } : { sheets: [] })
      respond(Response.json({ sheet }))
      await loading
      assert.deepEqual(useSheetStore.getState().layersById, {})
    }
  } finally {
    globalThis.fetch = originalFetch
    useSheetStore.setState({ workspaceId: '', sheets: [], layersById: {} })
  }
})


test('a refused deletion reaches the contextual action without removing the sheet', async () => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const sheet = { id: 'keep', workspaceId: 'ws', revision: 1 }
  useSheetStore.setState({ workspaceId: 'ws', sheets: [sheet] })
  globalThis.fetch = async () => new Response('This sheet is locked.', { status: 409 })
  console.error = () => {}
  try {
    await assert.rejects(useSheetStore.getState().deleteSheet('ws', sheet.id), /locked/)
    assert.deepEqual(useSheetStore.getState().sheets, [sheet])
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    useSheetStore.setState({ workspaceId: '', sheets: [] })
  }
})


test('sheet contents distinguish meaningful live edits from context and geometry', () => {
  const context = { fileId: 'heuristics.py', parentSystemId: 'heuristics', positionX: 12, positionY: 40, label: 'heuristics.py' }
  assert.equal(sheetElementHasChange(context, 'heuristics', 'heuristics'), false)
  assert.equal(sheetElementHasChange({ ...context, positionX: 900, positionY: 800, width: 200 }, 'heuristics', 'heuristics'), false, 'layout-only changes stay out of contents')
  assert.equal(sheetElementHasChange({ ...context, approvalStatus: 'approved' }, 'heuristics', 'heuristics'), false, 'an approved context reference is not a move')
  assert.equal(sheetElementHasChange(context, 'heuristics', 'planned:replay'), true, 'human responsibility moves remain discoverable')
  assert.equal(sheetElementHasChange({ ...context, approvalStatus: 'pending' }, 'heuristics', 'planned:replay'), true)
  assert.equal(sheetElementHasChange({ ...context, approvalStatus: 'rejected' }, 'heuristics', 'planned:replay'), false)
  assert.equal(sheetElementHasChange({ ...context, proposedName: 'New boundary', renameStatus: 'approved' }, 'heuristics', 'heuristics'), true)
  assert.equal(sheetElementHasChange({ ...context, proposedName: 'New boundary', renameStatus: 'rejected' }, 'heuristics', 'heuristics'), false)
  assert.equal(sheetElementHasChange({ ...context, designMetadata: { version: 1, symbols: [] } }, 'heuristics', 'heuristics'), true, 'authored symbol edits remain discoverable')
  assert.equal(sheetElementHasChange({ ...context, designMetadata: '{"version":1}' }, 'heuristics', 'heuristics'), false)
})
