import assert from 'node:assert/strict'
import test from 'node:test'
import { actionWorkItem, ambioRunWindows, outsideActivity, ranByAmbio, turnActions } from './outsideAgentActivity.ts'

const action = (id, agent, ts, extra = {}) => ({ id, workspaceId: 'w', ts, agent, tool: 'get_architecture', kind: 'read', summary: 'overview', targets: [], durationMs: 1, status: 'ok', ...extra })
const MIN = 60_000

test("a call made while Ambio's own run of that agent was at work is that run's, which already shows it", () => {
  const runs = [
    { key: 'r1', hostId: 'codex', startedAt: 1000 * MIN, state: 'completed' },
    { key: 'r2', hostId: 'claude-code', startedAt: 2000 * MIN, state: 'running' },
  ]
  const events = { r1: [{ at: 1010 * MIN }] }
  const windows = ambioRunWindows(runs, events, 2005 * MIN)
  assert.equal(ranByAmbio(action(1, 'codex', 1005 * MIN), windows), true)
  assert.equal(ranByAmbio(action(2, 'codex', 1010 * MIN + 30_000), windows), true, 'a minute of grace after its last event')
  assert.equal(ranByAmbio(action(3, 'codex', 1020 * MIN), windows), false, 'later, the same agent is working outside Ambio')
  assert.equal(ranByAmbio(action(4, 'cursor', 1005 * MIN), windows), false, 'another agent at the same time is outside')
  assert.equal(ranByAmbio(action(5, 'claude-code', 2005 * MIN), windows), true, 'a run still working covers up to now')
})

test('outside work is grouped by agent and work session, split by long pauses, newest first', () => {
  const actions = [
    action(1, 'codex', 10 * MIN, { sessionId: 's1' }),
    action(2, 'codex', 12 * MIN, { sessionId: 's1' }),
    action(3, 'cursor', 13 * MIN),
    action(4, 'codex', 14 * MIN, { sessionId: 'turn-session' }),
    action(5, 'cursor', 40 * MIN),
    action(6, 'cursor', 41 * MIN, { tool: 'connect', summary: 'Agent connected to Ambio' }),
  ]
  const groups = outsideActivity(actions, [], new Set(['turn-session']))
  assert.deepEqual(groups.map(group => [group.agent, group.actions.map(item => item.id)]), [
    ['cursor', [5]],
    ['cursor', [3]],
    ['codex', [1, 2]],
  ])
  assert.equal(groups[2].sessionId, 's1')
  assert.equal(groups[2].startedAt, 10 * MIN)
  assert.equal(groups[2].lastAt, 12 * MIN)
})

test("a turn's outside steps are its work sessions' calls, oldest first", () => {
  const actions = [action(2, 'codex', 20, { sessionId: 'a' }), action(1, 'codex', 10, { sessionId: 'a' }), action(3, 'codex', 15, { sessionId: 'b' })]
  assert.deepEqual(turnActions(actions, ['a']).map(item => item.id), [1, 2])
  assert.deepEqual(turnActions(actions, []), [])
})

test('a recorded call reads as an Ambio step that opens to what it was asked and answered', () => {
  const item = actionWorkItem(action(7, 'codex', 1, {
    tool: 'edit_systems', summary: 'Put 3 files in Payments', targets: ['s1'],
    detail: JSON.stringify({ input: '{ "op": "assign" }', output: '{ "ok": true }' }),
  }))
  assert.equal(item.text, 'Ambio · edit_systems · Put 3 files in Payments')
  assert.equal(item.kind, 'tool')
  assert.equal(item.input, '{ "op": "assign" }')
  assert.equal(item.output, '{ "ok": true }')
  assert.deepEqual(item.targets, ['s1'])
  const failed = actionWorkItem(action(8, 'codex', 1, { status: 'error', error: 'no such system', detail: 'not json' }))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.output, 'no such system')
  assert.equal(failed.input, undefined)
})
