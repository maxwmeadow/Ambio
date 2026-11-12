import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { claudeCommands } from './agentCommands.ts'
import { deliveryPlan } from './agentDelivery.ts'
import { CodexAppServer } from './codexAppServer.ts'
import { acpPrompt } from './acpClient.ts'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-agent-commands-'))
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

test("Claude Code's commands and skills are read where it keeps them, the project's first", () => {
  const root = scratch(), home = scratch()
  write(path.join(root, '.claude', 'commands', 'deploy.md'), '---\ndescription: Ship the current branch\n---\nDeploy $ARGUMENTS')
  write(path.join(root, '.claude', 'commands', 'db', 'migrate.md'), '# Run the migrations\nThen report.')
  write(path.join(home, '.claude', 'commands', 'deploy.md'), '---\ndescription: The user-level deploy\n---\n')
  write(path.join(home, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: "Write release notes from the log"\n---\nBody')
  assert.deepEqual(claudeCommands(root, home), [
    { name: 'db:migrate', description: 'Run the migrations' },
    { name: 'deploy', description: 'Ship the current branch' },
    { name: 'release-notes', description: 'Write release notes from the log' },
  ])
  assert.deepEqual(claudeCommands(scratch(), scratch()), [])
})

test('Claude Code runs a called command first; Ambio\u2019s request follows as the next message', () => {
  const plan = deliveryPlan('claude-code', { command: 'archd', args: [] }, 'ws', 'Check the work order', { command: { name: 'deploy', args: 'staging' } })
  assert.equal(JSON.parse(plan.stdin).message.content, '/deploy staging')
  assert.equal(JSON.parse(plan.followUp).message.content, 'Check the work order')
  assert.equal(deliveryPlan('claude-code', { command: 'archd', args: [] }, 'ws', 'p').followUp, undefined)
})

test('Codex gets a called skill named in its text and sent beside it', async t => {
  const sent = []
  const client = new CodexAppServer({
    cwd: process.cwd(), prompt: 'Claim Ambio request', mode: 'ask', skill: { name: 'ambio-build', args: 'the cache', path: 'C:/skills/ambio-build/SKILL.md' },
    onEvent: () => {}, onSession: () => {},
    send: line => {
      const message = JSON.parse(line); sent.push(message)
      queueMicrotask(() => {
        if (message.method === 'initialize') client.receive(JSON.stringify({ id: message.id, result: { userAgent: 'Codex Desktop/0.162.1 (Windows; ambio)' } }))
        else if (message.method === 'thread/start') client.receive(JSON.stringify({ id: message.id, result: { thread: { id: 'thread' }, approvalPolicy: message.params.approvalPolicy, approvalsReviewer: message.params.approvalsReviewer, sandbox: { type: message.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly' } } }))
        else if (message.method === 'turn/start') client.receive(JSON.stringify({ id: message.id, result: { turn: { id: 'turn' } } }))
        else if (message.method === 'skills/list') client.receive(JSON.stringify({ id: message.id, result: { data: [{ cwd: 'x', skills: [
          { name: 'ambio-build', description: 'Plan structure', path: 'C:/skills/ambio-build/SKILL.md', enabled: true },
          { name: 'off', description: '', path: 'C:/skills/off/SKILL.md', enabled: false },
        ] }] } }))
      })
    },
  })
  t.after(() => client.close())
  void client.run().catch(() => {})
  for (let i = 0; i < 20 && !sent.some(message => message.method === 'turn/start'); i++) await new Promise(resolve => setImmediate(resolve))
  const input = sent.find(message => message.method === 'turn/start').params.input
  assert.equal(input[0].text, '$ambio-build the cache\n\nClaim Ambio request')
  assert.deepEqual(input[1], { type: 'skill', name: 'ambio-build', path: 'C:/skills/ambio-build/SKILL.md' })
  assert.deepEqual(await client.skills('C:/project'), [{ name: 'ambio-build', description: 'Plan structure', path: 'C:/skills/ambio-build/SKILL.md' }])
  assert.deepEqual(sent.find(message => message.method === 'skills/list').params, { cwds: ['C:/project'] })
})

test('an ACP prompt carries only text when nothing is attached', () => {
  assert.deepEqual(acpPrompt('p', [], { image: true }), [{ type: 'text', text: 'p' }])
})
