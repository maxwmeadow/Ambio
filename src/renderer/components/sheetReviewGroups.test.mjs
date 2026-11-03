import assert from 'node:assert/strict'
import test from 'node:test'
import { sheetReviewGroups } from './sheetReviewGroups.ts'

const node = (id, parentSystemId = null) => ({ id, parentSystemId, name: id })
const addition = id => ({ key: `planned:${id}`, kind: 'addition', name: `Add ${id}`, focus: `planned:${id}` })
const edge = (id, source, target) => ({ key: id, kind: 'relationship', name: id, focus: source, source, target })

test('the replay tool is one change containing all eight exact requirements', () => {
  const nodes = [node('tool', 'live'), ...['cli', 'tests', 'scenes'].map(id => node(id, 'planned:tool'))]
  const items = [...nodes.map(n => addition(n.id)), edge('call', 'planned:cli', 'heuristics'), edge('test-cli', 'planned:tests', 'planned:cli'), edge('test-evaluator', 'planned:tests', 'heuristics'), edge('fixtures', 'planned:tests', 'planned:scenes')]
  const [group] = sheetReviewGroups(items, nodes)
  assert.equal(group.name, 'Add tool')
  assert.equal(group.items.length, 8)
  assert.equal(group.connections, 4)
  assert.equal(group.external, 2, 'connections outside the new boundary stay prominent')
  assert.deepEqual(new Set(group.items.map(item => item.key)), new Set(items.map(item => item.key)))
})

test('independent changes and their cross-boundary connection are not silently combined', () => {
  const nodes = [node('one'), node('two')]
  const groups = sheetReviewGroups([...nodes.map(n => addition(n.id)), edge('cross', 'planned:one', 'planned:two')], nodes)
  assert.equal(groups.length, 3)
  assert.deepEqual(groups.map(group => group.items.length), [1, 1, 1])
})

test('remaining children under an already reviewed parent keep their exact pending scope', () => {
  const nodes = [node('tool'), node('cli', 'planned:tool')]
  const [group] = sheetReviewGroups([addition('cli')], nodes)
  assert.equal(group.focus, 'planned:tool')
  assert.deepEqual(group.items.map(item => item.key), ['planned:cli'])
})
