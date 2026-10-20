import assert from 'node:assert/strict'
import test from 'node:test'
import { useSheetStore } from './sheetStore.ts'

test('unchanged sheet polls preserve canvas layers; resolution still removes the layer', async () => {
  const previous = useSheetStore.getState(), originalFetch = globalThis.fetch
  let resolved = false
  const sheet = { id: 'poll-sheet', revision: 1 }
  const layer = { sheet, elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [] }
  const layers = { [sheet.id]: layer }, visible = [sheet.id]
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/api/sheets?')
    ? [{ ...sheet, ...(resolved ? { resolvedAt: 1 } : {}) }] : { messages: [], availableCount: 0, nextCursor: '' }))
  try {
    useSheetStore.setState({ workspaceId: 'poll-workspace', sheets: [sheet], activeSheetId: sheet.id,
      layersById: layers, visibleSheetIds: visible, elements: layer.elements })
    await useSheetStore.getState().fetchSheets('poll-workspace')
    assert.equal(useSheetStore.getState().layersById, layers)
    assert.equal(useSheetStore.getState().visibleSheetIds, visible)
    assert.equal(useSheetStore.getState().elements, layer.elements)
    resolved = true
    await useSheetStore.getState().fetchSheets('poll-workspace')
    assert.deepEqual(useSheetStore.getState().layersById, {})
    assert.deepEqual(useSheetStore.getState().visibleSheetIds, [])
    assert.equal(useSheetStore.getState().activeSheetId, null)
    await new Promise(resolve => setImmediate(resolve))
  } finally { globalThis.fetch = originalFetch; useSheetStore.setState(previous, true) }
})
