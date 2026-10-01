import assert from 'node:assert/strict'
import test from 'node:test'
import { NO_FILTER, claimMatches, kindGroup, reviewFilterOptions } from './reviewFilters.ts'

const claim = (id, patch) => ({
  id, kind: 'system.coupling', title: id, subtitle: '', severity: 1, score: 1, actor: 'agent', ts: 1,
  createsCycle: false, internal: false, evidence: [], ...patch,
})
const claims = [
  claim('moved', { kind: 'meaning.moved', actor: 'human', focusFileIds: ['f-pay'] }),
  claim('coupled', { sessionId: 's1', focusSystemIds: ['orders', 'payments'] }),
  claim('stray', { kind: 'file.unclassified', focusFileIds: ['f-orders'] }),
]
const context = {
  sessions: new Map([['s1', { agent: 'codex' }]]),
  systemOfFile: new Map([['f-pay', 'payments'], ['f-orders', 'orders']]),
  sessionGoals: new Map([['s1', 'Add retries']]),
  systemNames: new Map([['orders', 'Orders'], ['payments', 'Payments']]),
}
const shown = (filter, seen = new Set()) =>
  claims.filter(c => claimMatches(c, { ...NO_FILTER, ...filter }, context, seen)).map(c => c.id)

test('filters by who, work, kind and system', () => {
  assert.deepEqual(shown({}), ['moved', 'coupled', 'stray'])
  assert.deepEqual(shown({ who: 'human' }), ['moved'])
  assert.deepEqual(shown({ who: 'unexplained' }), ['stray'])
  assert.deepEqual(shown({ who: 'agent:codex' }), ['coupled'])
  assert.deepEqual(shown({ work: 's1' }), ['coupled'])
  assert.deepEqual(shown({ kind: 'meaning' }), ['moved'])
  assert.deepEqual(shown({ system: 'payments' }), ['moved', 'coupled'])
  assert.deepEqual(shown({ hideSeen: true }, new Set(['coupled'])), ['moved', 'stray'])
})

test('offers only choices some claim has, with counts', () => {
  const options = reviewFilterOptions(claims, context)
  assert.deepEqual(options.who.map(o => `${o.label}:${o.count}`).sort(), ['Agents:1', 'Unexplained:1', 'You:1', 'codex:1'])
  assert.deepEqual(options.work.map(o => o.label), ['Add retries'])
  assert.deepEqual(options.system.map(o => `${o.label}:${o.count}`), ['Orders:2', 'Payments:2'])
  assert.equal(kindGroup('system.hub'), 'dependencies')
  assert.equal(kindGroup('system.added'), 'systems')
})
