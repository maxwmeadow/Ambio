import assert from 'node:assert/strict'
import test from 'node:test'
import { AMBIO_COMMANDS, commandCall, commandLine, matchCommands, typedCommand, validCommandCall } from './agentCommands.ts'

test('the menu opens while a command name is typed at the start of the box', () => {
  assert.equal(typedCommand('/'), '')
  assert.equal(typedCommand('/pla'), 'pla')
  assert.equal(typedCommand('/frontend-design:frontend-design'), 'frontend-design:frontend-design')
  assert.equal(typedCommand('/plan the cache'), null, 'once arguments start, the menu has done its job')
  assert.equal(typedCommand('use /plan'), null)
})

test('matching is by name, names that start with what is typed first; descriptions only when asked', () => {
  const commands = [{ name: 'compact', description: 'Summarize' }, { name: 'replan', description: 'Plan again' }, { name: 'plan', description: 'Plan carefully' }, { name: 'goal', description: 'Run until the plan is done' }]
  assert.deepEqual(matchCommands('pl', commands).map(command => command.name), ['plan', 'replan'])
  assert.deepEqual(matchCommands('summ', commands).map(command => command.name), [])
  assert.deepEqual(matchCommands('summ', commands, 'description').map(command => command.name), ['compact'])
  assert.deepEqual(matchCommands('', AMBIO_COMMANDS).map(command => command.name), ['ask', 'propose', 'build', 'new', 'attach'])
})

test("a message that starts with one of the agent's commands calls it; anything else is a plain message", () => {
  const commands = [{ name: 'plan', description: '' }, { name: 'ambio-build', description: '', path: 'C:/skills/ambio-build/SKILL.md' }]
  assert.deepEqual(commandCall('/plan the cache\nand the rest', commands), { name: 'plan', args: 'the cache' })
  assert.deepEqual(commandCall('/ambio-build', commands), { name: 'ambio-build', args: '', path: 'C:/skills/ambio-build/SKILL.md' })
  assert.equal(commandCall('/unknown thing', commands), null)
  assert.equal(commandCall('plan the cache', commands), null)
  assert.equal(commandLine({ name: 'plan', args: 'the cache' }), '/plan the cache')
  assert.equal(commandLine({ name: 'compact', args: '' }), '/compact')
})

test('a command call from the page is checked before it reaches an agent', () => {
  assert.deepEqual(validCommandCall({ name: 'plan', args: 'x' }), { name: 'plan', args: 'x' })
  assert.equal(validCommandCall({ name: 'plan; rm -rf', args: '' }), undefined)
  assert.equal(validCommandCall({ name: 'plan', args: 'two\nlines' }), undefined)
  assert.equal(validCommandCall('plan'), undefined)
})
