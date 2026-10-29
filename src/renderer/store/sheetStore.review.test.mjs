import assert from 'node:assert/strict'
import test from 'node:test'
import { useSheetStore } from './sheetStore.ts'

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
