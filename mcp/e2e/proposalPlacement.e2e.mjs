import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'

// An agent proposing a split could only draw empty top-level boxes, could not
// read symbols by path, and was told a parent system held no files because they
// all sat in its sub-systems. These are the reads and draws a proposal needs.
test('a proposal is drawn inside its parent, owns the files it takes over, and reads the map it builds on', { timeout: 90000 }, async () => {
  const harness = await startHarness()
  try {
    const { client, workspaceId, apiBase } = harness
    const file = path => harness.snapshot.files.find(candidate => candidate.relPath === path)
    const created = async (name, parentId) => {
      const result = await client.callTool('edit_systems', { op: 'create', name, description: name, ...(parentId ? { parentId } : {}) })
      assert.equal(result.isError, false, result.text)
      return result.payload?.systemId ?? result.payload?.id
    }
    const storage = await created('Storage')
    const records = await created('Records', storage)
    const assigned = await client.callTool('edit_systems', { op: 'assign', systemId: records, fileIds: [file('storage/record.py').id, file('storage/task_store.py').id] })
    assert.equal(assigned.isError, false, assigned.text)

    // The parent's files live in its sub-system: it is not empty.
    const overview = await client.callTool('get_architecture', { scope: 'overview' })
    const parent = overview.payload.find(system => system.id === storage)
    assert.equal(parent.fileCount, 2)
    assert.equal(parent.directFileCount, 0)
    const inside = await client.callTool('get_architecture', { scope: 'system_files', id: storage })
    assert.deepEqual(inside.payload.map(row => [row.relPath, row.system]), [['storage/record.py', 'Records'], ['storage/task_store.py', 'Records']])
    const around = await client.callTool('get_architecture', { scope: 'neighbors', id: storage })
    assert.deepEqual(around.payload.children.map(child => child.name), ['Records'])

    // Symbols by path, the way the tool describes.
    const symbols = await client.callTool('get_symbols', { file: 'storage/record.py' })
    assert.equal(symbols.isError, false, symbols.text)
    assert.equal(symbols.payload[0].fileId, file('storage/record.py').id)

    const sheet = await client.callTool('edit_sheet', { op: 'create', name: 'Split records', purpose: 'Task storage gets its own boundary', members: [storage] })
    const sheetId = sheet.payload.created.id
    // A new system inside Storage that takes over task_store.py.
    const tasks = await client.callTool('plan_element', { sheet: sheetId, name: 'Task Records', kind: 'system', parent: 'Storage', owns: ['storage/task_store.py'] })
    assert.equal(tasks.isError, false, tasks.text)
    assert.equal(tasks.payload.parentSystemId, storage)
    assert.deepEqual(tasks.payload.owns, ['storage/task_store.py'])
    // A planned parent works by name too, and a file is no parent.
    const nested = await client.callTool('plan_element', { sheet: sheetId, name: 'Task Index', kind: 'system', parent: 'Task Records' })
    assert.equal(nested.payload.parentSystemId, `planned:${tasks.payload.id}`)
    const fileParent = await client.callTool('plan_element', { sheet: sheetId, name: 'Nowhere', kind: 'system', parent: 'storage/record.py' })
    assert.equal(fileParent.isError, true)
    // An existing node changes boundary; moving a system inside itself is refused.
    const moved = await client.callTool('edit_sheet', { op: 'move', sheet: sheetId, members: ['storage/index.py'], target: 'Task Records' })
    assert.equal(moved.isError, false, moved.text)
    const cycle = await client.callTool('edit_sheet', { op: 'move', sheet: sheetId, members: [storage], target: 'Records' })
    assert.equal(cycle.isError, true)
    assert.match(cycle.text, /inside itself/)

    // The sheet carries the moves: each file once, under its new parent, with
    // no layout pinning it anywhere - the canvas places it inside its parent.
    const stored = await (await fetch(`${apiBase}/api/sheets/${sheetId}?workspace=${workspaceId}`)).json()
    const element = path => stored.elements.filter(candidate => candidate.fileId === file(path).id)
    assert.equal(element('storage/task_store.py').length, 1)
    assert.equal(element('storage/task_store.py')[0].parentSystemId, `planned:${tasks.payload.id}`)
    assert.equal(element('storage/index.py')[0].parentSystemId, `planned:${tasks.payload.id}`)
    assert.ok(!stored.layouts.some(layout => layout.nodeId === file('storage/task_store.py').id))
    // compare reads the intended parent from the sheet.
    const compared = await client.callTool('edit_sheet', { op: 'compare', sheet: sheetId })
    const taskStore = compared.payload.nodes.find(node => node.id === file('storage/task_store.py').id)
    assert.equal(taskStore.parentId, `planned:${tasks.payload.id}`)

    // An agent's moves and relationships wait for the human, like its planned nodes.
    assert.equal(element('storage/index.py')[0].approvalStatus, 'pending')
    const related = await client.callTool('edit_sheet', { op: 'connect', sheet: sheetId, from: tasks.payload.id, to: records, kind: 'DEPENDS_ON' })
    assert.equal(related.isError, false, related.text)
    assert.equal(related.payload.approvalStatus, 'pending')
    const waiting = await client.callTool('edit_sheet', { op: 'compare', sheet: sheetId })
    const approvals = waiting.payload.differences.filter(difference => difference.kind === 'approval').map(difference => difference.detail)
    assert.ok(approvals.includes('Proposed move still needs user approval'))
    assert.ok(approvals.includes('Proposed relationship still needs user approval'))
    // The human decides through the API: confirm the task store move and the
    // planned system, reject moving index.py, which goes back where it was.
    const post = (path, body) => fetch(`${apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, ...body }) })
    for (const [path, decision] of [
      [`/api/sheets/${sheetId}/elements/${element('storage/task_store.py')[0].id}/approval`, 'approved'],
      [`/api/sheets/${sheetId}/elements/${element('storage/index.py')[0].id}/approval`, 'rejected'],
      [`/api/sheets/${sheetId}/planned-edges/${related.payload.id}/approval`, 'rejected'],
      [`/api/planned/${tasks.payload.id}/approval`, 'approved'],
    ]) {
      const response = await post(path, { decision })
      assert.ok(response.ok, await response.text())
    }
    const decided = await (await fetch(`${apiBase}/api/sheets/${sheetId}?workspace=${workspaceId}`)).json()
    const index = decided.elements.find(candidate => candidate.fileId === file('storage/index.py').id)
    assert.equal(index.approvalStatus, 'rejected')
    assert.equal(index.parentSystemId, file('storage/index.py').systemId ?? null)
    // Only what was confirmed reaches the builder: the move, not the rejected relationship.
    const spec = await client.callTool('get_build_plan', { sheet: sheetId })
    const specText = JSON.stringify(spec.payload)
    assert.match(specText, /move storage\/task_store\.py into planned:Task Records/)
    assert.doesNotMatch(specText, /move storage\/index\.py/)
    assert.doesNotMatch(specText, /planned:Task Records DEPENDS_ON/)
  } finally { harness.stop() }
})
