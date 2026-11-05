import assert from 'node:assert/strict'
import test from 'node:test'
import { projectPath, statusLabel, toolRow } from './agentActivity.ts'

test('every agent\'s tool rows get the badge for what the tool does', () => {
  // Claude Code, Codex and an ACP agent name the same kinds of tool differently.
  assert.equal(toolRow('Bash · npm test').badge, 'Run')
  assert.equal(toolRow('Shell · npm test').badge, 'Run')
  assert.equal(toolRow('PowerShell · Get-ChildItem').badge, 'Run')
  assert.equal(toolRow('Glob · src/**/*.ts').badge, 'Search')
  assert.equal(toolRow('Grep · TODO').badge, 'Search')
  assert.equal(toolRow('Read · src/app.ts').badge, 'Read')
  assert.equal(toolRow('Edit · src/a.ts, src/b.ts').badge, 'Edit')
  assert.equal(toolRow('MultiEdit · src/a.ts').badge, 'Edit')
  assert.equal(toolRow('WebFetch · https://example.com').badge, 'Web')
  assert.equal(toolRow('Task · Explore the API').badge, 'Agent')
  assert.equal(toolRow('Reading src/app.ts').badge, 'Read')
  assert.equal(toolRow('Run the tests · src').badge, 'Run')
  assert.equal(toolRow('Changes in this turn').badge, 'Tool')
  assert.deepEqual(toolRow('Ambio · get_architecture · overview'), { badge: 'Ambio', tool: 'get_architecture', target: 'overview' })
})

test('a subagent\'s work keeps its real tool, and Codex\'s subagent name', () => {
  // Claude Code marks the row; Codex also names the subagent.
  assert.deepEqual(toolRow('Subagent · Grep · TODO'), { badge: 'Search', tool: 'Grep', target: 'TODO', subagent: '' })
  assert.deepEqual(toolRow('Subagent · Ada · explorer · Shell · ls'), { badge: 'Run', tool: 'Shell', target: 'ls', subagent: 'Ada · explorer' })
  // Codex's own subagent events: who started whom, and what a subagent is doing.
  assert.deepEqual(toolRow('Subagent · Main agent · spawn_agent → Ada (running)'), { badge: 'Agent', tool: 'spawn_agent → Ada (running)', target: '', subagent: 'Main agent' })
  assert.deepEqual(toolRow('Subagent · reviewer · Shell · ls'), { badge: 'Run', tool: 'Shell', target: 'ls', subagent: 'reviewer' })
  assert.deepEqual(toolRow('Subagent · Ambio · get_inbox'), { badge: 'Ambio', tool: 'get_inbox', target: '', subagent: '' })
})

test('the project\'s own paths read as they do in the project, whichever slashes the agent used', () => {
  assert.equal(projectPath('Read · C:\\work\\demo\\src\\app.ts', 'C:\\work\\demo'), 'Read · src/app.ts')
  assert.equal(projectPath('Read · c:/work/demo/src/app.ts', 'C:\\work\\demo\\'), 'Read · src/app.ts')
  assert.equal(projectPath('Edit · /home/max/demo/a.ts, /home/max/demo/b.ts', '/home/max/demo'), 'Edit · a.ts, b.ts')
  // A POSIX root keeps its case; a path outside the project, or a longer name, is left alone.
  assert.equal(projectPath('Read · /home/Max/demo/a.ts', '/home/max/demo'), 'Read · /home/Max/demo/a.ts')
  assert.equal(projectPath('Read · /home/max/demo2/a.ts', '/home/max/demo'), 'Read · /home/max/demo2/a.ts')
  assert.equal(projectPath('Read · /etc/hosts', '/home/max/demo'), 'Read · /etc/hosts')
  assert.equal(projectPath('Read · /etc/hosts', ''), 'Read · /etc/hosts')
  assert.equal(toolRow('Read · C:\\work\\demo\\src\\app.ts', 'C:\\work\\demo').target, 'src/app.ts')
})

test('statuses read the same for every agent', () => {
  assert.deepEqual(['inProgress', 'in_progress', 'pending', 'completed', 'failed', 'declined', 'cancelled'].map(statusLabel),
    ['running', 'running', 'waiting', 'done', 'failed', 'declined', 'cancelled'])
})
