import assert from 'node:assert/strict'
// Read-only with respect to developer projects: every mutation below targets
// the harness's throwaway workspace. Prints capability observations, not a
// passing security test. Run explicitly; it does not launch a real agent.
import { startHarness, harnessFetch } from './mcpHarness.mjs'

const workspaceId = `mapping-tail-audit-${Date.now()}`
const h = await startHarness({ workspaceId, env: { AMBIO_WORKSPACE_ID: workspaceId, AMBIO_RUN_MESSAGE_ID: 'audit-mapping' } })
const observations = []
const call = async (label, tool, args) => {
  const r = await h.client.callTool(tool, args)
  observations.push({ label, accepted: !r.isError, result: r.payload })
  return r
}
const post = async (route, body) => {
  const r = await harnessFetch(`${h.apiBase}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
try {
  assert.equal((await post('/api/canvas/send', { id: 'audit-mapping', workspaceId, deliveryMode: 'addressed', mode: 'propose', note: 'This is a mapping request. Do not change any code. Propose the architecture.' })).status, 200)
  const claimed = await call('claim mapping', 'get_inbox', { messageId: 'audit-mapping', expectedWorkspaceId: workspaceId })
  const messageHandle = claimed.payload.messages[0].messageHandle
  const started = await call('start mapping narration', 'start_work', { messageHandle, goal: 'Map project' })
  const begun = await call('begin draft', 'edit_systems', { op: 'begin_session', rationale: 'Audit mapping completion' })
  const sessionId = begun.payload.sessionId
  await call('add draft chunk', 'edit_systems', { op: 'add_chunk', sessionId, chunkId: 'first', systems: [{ systemKey: 'storage', name: 'Audit Storage', files: ['storage/record.py'] }] })
  const committed = await call('submit proposal while connection remains active', 'edit_systems', { op: 'commit_session', sessionId })
  const proposalId = committed.payload.proposalId
  await call('new chunk after submission', 'edit_systems', { op: 'add_chunk', sessionId, chunkId: 'late', systems: [{ systemKey: 'late', name: 'Late', files: ['api/handlers.py'] }] })
  const replay = await call('repeat submission', 'edit_systems', { op: 'commit_session', sessionId })
  assert.equal(replay.payload.proposalId, proposalId)
  await call('create live system while proposal pending', 'edit_systems', { op: 'create', name: 'Premature Live System' })
  const existing = h.snapshot.systems?.[0]
  if (existing) await call('rename existing live system while proposal pending', 'edit_systems', { op: 'update', systemId: existing.id, name: 'Changed During Pending Review' })
  await call('finish work narration after submission', 'update_work', { sessionId: started.payload.sessionId, done: true, summary: 'Proposal submitted' })
  await call('finish same work narration again', 'update_work', { sessionId: started.payload.sessionId, done: true, summary: 'Proposal submitted' })
  await call('submit canvas reply', 'reply_to_canvas', { messageHandle, body: 'Map submitted for review.' })
  await call('repeat identical canvas reply', 'reply_to_canvas', { messageHandle, body: 'Map submitted for review.' })
  await call('replace answered canvas reply', 'reply_to_canvas', { messageHandle, body: 'Different result.' })
  await call('restart addressed work after reply', 'start_work', { messageHandle, goal: 'Keep working' })
  const standalone = await call('restart standalone work after reply', 'start_work', { goal: 'Keep working without message handle' })
  const finalized = await post(`/api/architecture-proposals/${proposalId}/finalize`, { workspaceId, revision: 1, decidedBy: 'user' })
  observations.push({ label: 'human finalizes while MCP connection stays active', status: finalized.status })
  assert.equal(finalized.status, 200)
  await call('create live system after human finalized', 'edit_systems', { op: 'create', name: 'Post Review Live System' })
  const systemId = finalized.body.proposal.round.systems[0].materializedSystemId
  await call('rename accepted live system from same completed mapping turn', 'edit_systems', { op: 'update', systemId, name: 'Changed After Human Review' })
  const second = await call('start another mapping draft after human finalized', 'edit_systems', { op: 'begin_session', rationale: 'Late second proposal' })
  await call('add second draft', 'edit_systems', { op: 'add_chunk', sessionId: second.payload.sessionId, chunkId: 'second', systems: [{ systemKey: 'api', name: 'Audit API', files: ['api/handlers.py'] }] })
  await call('submit second proposal from same mapping connection', 'edit_systems', { op: 'commit_session', sessionId: second.payload.sessionId })
  const listed = await (await harnessFetch(`${h.apiBase}/api/architecture-proposals?workspace=${workspaceId}`)).json()
  observations.push({ label: 'proposal list after late submission', count: listed.length, newestIsOriginal: listed[0].id === proposalId })
  const revised = await post(`/api/architecture-proposals/${proposalId}/revisions`, { workspaceId, expectedRevision: 1, round: { coverage: 'no_change', rationale: 'After review', systems: [{ systemKey: 'new', name: 'New Round After Finalize', parentRefType: 'scope', depth: 0 }], memberships: [] } })
  observations.push({ label: 'API revision of already finalized proposal', status: revised.status, revision: revised.body.currentRevision })
  await call('close audit narration', 'update_work', { sessionId: standalone.payload.sessionId, done: true, summary: 'Audit complete' })
  console.log(JSON.stringify(observations.map(({ result, ...observation }) => ({
    ...observation, ...(result?.error ? { error: result.error } : {}),
  })), null, 2))
} finally { h.stop() }
