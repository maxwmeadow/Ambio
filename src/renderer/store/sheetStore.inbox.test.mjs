import assert from 'node:assert/strict'
import test from 'node:test'
import { useSheetStore, refreshInbox, handleSheetPatch } from './sheetStore.ts'

const response = messages => new Response(JSON.stringify({ messages, nextCursor: '' }), { status: 200 })
test('history recovers replies and ignores stale responses across project switches', async () => {
  const original = globalThis.fetch
  let release
  globalThis.fetch = () => new Promise(resolve => { release = resolve })
  try {
    useSheetStore.setState({ workspaceId: 'a', messages: [] })
    const old = refreshInbox('a')
    useSheetStore.setState({ workspaceId: 'b', messages: [] })
    release(response([{ id: 'private', workspaceId: 'a', createdAt: 1 }]))
    await old
    assert.deepEqual(useSheetStore.getState().messages, [])
    globalThis.fetch = async () => response([{ id: 'reply', workspaceId: 'b', createdAt: 2, status: 'answered', reply: { body: 'saved reply' } }])
    await refreshInbox('b')
    assert.equal(useSheetStore.getState().messages[0].reply.body, 'saved reply')
    let calls = 0
    globalThis.fetch = async () => { calls++; return response([]) }
    handleSheetPatch({ type: 'canvas:message', payload: { id: 'foreign', workspaceId: 'a' } })
    assert.equal(calls, 0)
    assert.equal(useSheetStore.getState().messages.length, 1)
  } finally { globalThis.fetch = original; useSheetStore.setState({ workspaceId: null, messages: [] }) }
})
test('overlapping history requests share one fetch rather than starving slow responses', async () => {
  const original = globalThis.fetch
  const releases = []
  globalThis.fetch = () => new Promise(resolve => releases.push(resolve))
  try {
    useSheetStore.setState({ workspaceId: 'a', messages: [] })
    const first = refreshInbox('a'), second = refreshInbox('a')
    assert.equal(first, second)
    assert.equal(releases.length, 1)
    releases[0](response([{ id: 'm', workspaceId: 'a', createdAt: 1, status: 'answered' }]))
    await second
    await first
    assert.equal(useSheetStore.getState().messages[0].status, 'answered')
  } finally { globalThis.fetch = original; useSheetStore.setState({ workspaceId: null, messages: [] }) }
})

test('refresh recovers replies on already-loaded older pages', async () => {
  const original = globalThis.fetch
  const older = { id: 'older', workspaceId: 'a', createdAt: 1, status: 'queued' }
  const newer = { id: 'newer', workspaceId: 'a', createdAt: 2, status: 'answered' }
  const urls = []
  globalThis.fetch = async url => {
    urls.push(url)
    return new Response(JSON.stringify(url.includes('before=newer')
      ? { messages: [{ ...older, status: 'answered', reply: { body: 'Recovered older reply' } }], nextCursor: '', availableCount: 0 }
      : { messages: [newer], nextCursor: 'newer', availableCount: 0 }))
  }
  try {
    useSheetStore.setState({ workspaceId: 'a', messages: [older, newer] })
    await refreshInbox('a')
    assert.equal(urls.length, 2)
    assert.equal(useSheetStore.getState().messages[0].reply.body, 'Recovered older reply')
    assert.equal(useSheetStore.getState().inboxAvailableCount, 0)
  } finally { globalThis.fetch = original; useSheetStore.setState({ workspaceId: null, messages: [] }) }
})

test('resolved sheet events remove active overlays but preserve recoverable sheet history', () => {
  const sheet = { id: 'design', workspaceId: 'a', revision: 3, name: 'Design' }
  const layer = { sheet, elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [] }
  useSheetStore.setState({ workspaceId: 'a', sheets: [sheet], activeSheetId: sheet.id, visibleSheetIds: [sheet.id], layersById: { [sheet.id]: layer } })
  try {
    handleSheetPatch({ type: 'sheet:upserted', payload: { ...sheet, resolvedAt: 42 } })
    const state = useSheetStore.getState()
    assert.equal(state.activeSheetId, null)
    assert.deepEqual(state.visibleSheetIds, [])
    assert.deepEqual(state.layersById, {})
    assert.equal(state.sheets[0].resolvedAt, 42)
    handleSheetPatch({ type: 'sheet:upserted', payload: sheet })
    assert.equal(useSheetStore.getState().sheets[0].resolvedAt, 42, 'late same-revision event cannot resurrect an archive')
    handleSheetPatch({ type: 'sheet:upserted', payload: { ...sheet, revision: 4 } })
    assert.equal(useSheetStore.getState().sheets[0].resolvedAt, undefined)
    handleSheetPatch({ type: 'sheet:upserted', payload: { ...sheet, resolvedAt: 42 } })
    assert.equal(useSheetStore.getState().sheets[0].revision, 4, 'late resolution must not hide restored revision')
  } finally { useSheetStore.setState({ workspaceId: null, sheets: [], layersById: {}, visibleSheetIds: [], activeSheetId: null }) }
})
