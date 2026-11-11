import assert from 'node:assert/strict'
import test from 'node:test'
import { actionDetail, actionKind, actionSummary, actionTargets } from './agentAction.ts'

test('reads are the default so a new tool is still captured', () => {
  assert.equal(actionKind('some_tool_added_next_month'), 'read')
  assert.equal(actionKind('get_architecture'), 'read')
})

test('kinds separate the things the canvas animates differently', () => {
  assert.equal(actionKind('get_call_path'), 'trace')
  assert.equal(actionKind('get_data_flow'), 'trace')
  assert.equal(actionKind('edit_systems'), 'write')
  assert.equal(actionKind('merge_systems'), 'write')
  assert.equal(actionKind('plan_element'), 'plan')
  assert.equal(actionKind('inject_value'), 'debug')
  assert.equal(actionKind('start_work'), 'narrate')
})

test('targets come from whichever id-bearing argument the tool used', () => {
  assert.deepEqual(actionTargets('get_node', { nodeId: 'n1' }), ['n1'])
  assert.deepEqual(
    actionTargets('assign_files_to_system', { fileIds: ['f1', 'f2'], systemId: 's1' }),
    ['f1', 'f2', 's1'],
  )
})

test('the consolidated id/ids vocabulary is recognised', () => {
  // get_architecture takes a generic `id`. Missing it meant every read through
  // the new surface recorded no targets, so the canvas lit nothing at all.
  assert.deepEqual(actionTargets('get_architecture', { scope: 'node', id: 'n1' }), ['n1'])
  assert.deepEqual(
    actionTargets('get_architecture', { scope: 'systems', ids: ['s1', 's2'] }),
    ['s1', 's2'],
  )
})

test('a traced path targets every hop, not just the endpoints', () => {
  const targets = actionTargets(
    'get_call_path',
    { from: 'a', to: 'c' },
    { steps: [
      { callerFile: 'a', calleeFile: 'b' },
      { callerFile: 'b', calleeFile: 'c' },
    ] },
  )
  assert.deepEqual(targets, ['a', 'c', 'b'], 'the middle of the path is the interesting part')
})

test('a data-flow slice targets every file it touched', () => {
  const targets = actionTargets('get_data_flow', { variable: 'token' }, { fileIds: ['f1', 'f2'] })
  assert.deepEqual(targets, ['f1', 'f2'])
})

test('targets are deduplicated so one node is lit once', () => {
  const targets = actionTargets('get_call_path', { from: 'a', to: 'a' }, {
    steps: [{ callerFile: 'a', calleeFile: 'a' }],
  })
  assert.deepEqual(targets, ['a'])
})

test('an action with nothing to point at yields no targets', () => {
  assert.deepEqual(actionTargets('get_systems_overview', {}), [])
})

test('summaries say what a call was about, after the tool name the step already shows', () => {
  assert.equal(
    actionSummary('get_call_path', { from: 'handlers.py', to: 'store.py' }),
    'Traced handlers.py → store.py',
  )
  assert.equal(actionSummary('create_system', { name: 'Storage' }), 'Created system Storage')
  assert.equal(actionSummary('start_work', { goal: 'Add caching' }), 'Add caching')
  assert.equal(actionSummary('search_symbols', { query: 'TaskStore' }), '"TaskStore"')
})

test("today's tools say what they did, naming systems rather than ids", () => {
  const names = new Map([['s1', 'Payments'], ['s2', 'Billing']])
  assert.equal(actionSummary('edit_systems', { op: 'assign', systemId: 's1', fileIds: ['a', 'b', 'c'] }, names), 'Put 3 files in Payments')
  assert.equal(actionSummary('edit_systems', { op: 'merge', sourceSystemId: 's2', targetSystemId: 's1' }, names), 'Merged Billing into Payments')
  assert.equal(actionSummary('edit_systems', { op: 'add_chunk', systems: [{}, {}] }), 'Drafted 2 systems')
  assert.equal(actionSummary('edit_systems', { op: 'assign', systemId: 'gone', filePaths: ['x'] }), 'Put 1 file in a system')
  assert.equal(actionSummary('get_architecture', {}), 'overview')
  assert.equal(actionSummary('get_architecture', { scope: 'cross_dependencies', id: 's1' }, names), 'cross dependencies of Payments')
  assert.equal(actionSummary('edit_sheet', { op: 'annotate', sheet: 'Checkout' }), 'Added a note on Checkout')
  assert.equal(actionSummary('get_inbox', { messageHandle: 'h' }), 'Read a request')
  assert.equal(actionSummary('update_work', { note: 'Wired the cache' }), 'Wired the cache')
})

test('an unmapped tool says nothing it does not know; its name is shown already', () => {
  assert.equal(actionSummary('get_systems_overview', {}), '')
})

test('ids inside a batch of edits are targets too', () => {
  assert.deepEqual(actionTargets('edit_systems', { op: 'bulk', updates: [{ systemId: 's1', name: 'A' }, { systemId: 's2' }] }).sort(), ['s1', 's2'])
})

test('an action keeps what it was asked and what came back, trimmed', () => {
  const detail = JSON.parse(actionDetail({ op: 'overview' }, { systems: 3 }))
  assert.match(detail.input, /"op": "overview"/)
  assert.match(detail.output, /"systems": 3/)
  assert.equal(JSON.parse(actionDetail({}, { ok: true }, 'boom')).output, 'boom')
  assert.ok(JSON.parse(actionDetail({ text: 'x'.repeat(9000) }, null)).input.length < 4100)
  assert.deepEqual(JSON.parse(actionDetail({}, undefined)), {})
})

test('every advertised tool is classified as the thing it actually does', () => {
  // The log records the name the agent called, not the legacy name it routes
  // to, so the consolidated surface has to appear in these sets. trace_calls
  // did not, and was filed as a read.
  assert.equal(actionKind('trace_calls'), 'trace')
  assert.equal(actionKind('get_data_flow'), 'trace')
  assert.equal(actionKind('edit_systems'), 'write')
  assert.equal(actionKind('investigation'), 'debug')
  assert.equal(actionKind('update_work'), 'narrate')
  assert.equal(actionKind('get_architecture'), 'read')
})
