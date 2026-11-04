import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { DeliveryRunner } from './agentDelivery.ts'
import { workOrderHandoff } from '../src/shared/workOrderHandoff.ts'

const peer = fileURLToPath(new URL('../tests/e2e/fixtures/codex-app-server.cjs', import.meta.url))
const wait = async (runner, key, condition) => {
  for (let i = 0; i < 300; i++) {
    const run = runner.list('ws').find(item => item.key === key)
    if (condition(run)) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(JSON.stringify(runner.list('ws')))
}
function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-codex-delivery-'))
  const directory = path.join(root, 'receipts')
  if (mode) fs.writeFileSync(path.join(root, 'codex-fixture-mode.json'), JSON.stringify({ mode }))
  const runner = new DeliveryRunner(directory, (command, args, options) => {
    const env = { ...options.env }; delete env.NODE_TEST_CONTEXT
    return spawn(command, args, { ...options, env })
  })
  t.after(async () => { await runner.stopAll(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, directory, runner, input: { workspaceId: 'ws', messageId: 'message', hostId: 'codex', threadId: 'conversation', rootPath: root, revision: 'initial', launcher: { command: process.execPath, args: [] }, args: [peer], prompt: 'Claim this exact request', mode: 'build', codex: {}, codexTransport: 'app-server' }, captured: () => JSON.parse(fs.readFileSync(path.join(root, 'captured-codex.json'), 'utf8')) }
}

test('native receipts, output snapshots, usage, steering and graceful Stop survive process boundaries', async t => {
  const f = fixture(t, 'hold')
  const run = await f.runner.start(f.input)
  await wait(f.runner, run.key, run => run.canSteer)
  assert.equal(f.runner.session('ws', 'conversation', 'codex'), 'codex-fixture-thread')
  await assert.rejects(f.runner.steer('other', run.key, 'wrong project'), /no longer/)
  await f.runner.steer('ws', run.key, 'Keep the API')
  await wait(f.runner, run.key, () => f.runner.events('ws', run.key).find(e => e.id === 'codex:text')?.text === 'Fixture is reading the project.')
  assert.equal(f.runner.events('ws', run.key).filter(e => e.id === 'codex:text').length, 1)
  assert.equal(f.runner.events('ws', run.key).find(e => e.id === 'codex:text').text, 'Fixture is reading the project.')
  assert.equal(f.captured().corrections[0].expectedTurnId, f.captured().turn)
  await f.runner.stop('ws', run.key)
  const stopped = await wait(f.runner, run.key, run => run.state === 'stopped')
  assert.equal(stopped.canSteer, false)
  assert.equal(f.captured().interrupted, true)
  assert.equal(stopped.usage.outputTokens, 3)
  assert.equal(new DeliveryRunner(f.directory).codexTransport('ws', 'conversation'), 'app-server')
  const next = await f.runner.start({ ...f.input, messageId: 'followup', codex: { resume: stopped.sessionId } })
  await wait(f.runner, next.key, run => run.canSteer)
  assert.equal(f.captured().setup.threadId, stopped.sessionId)
  assert.equal(f.captured().cwd, fs.realpathSync(f.root))
})

test('native failure with exit zero stays failed and never runs a fallback', async t => {
  const f = fixture(t, 'fail')
  let retried = 0
  const run = await f.runner.start({ ...f.input, fresh: () => { retried++; return { args: [] } } })
  await wait(f.runner, run.key, run => run.state === 'failed')
  assert.equal(retried, 0)
  assert.ok(f.runner.events('ws', run.key).some(e => e.text === 'Fixture quota error'))
})

test('native reviewer output is handed back through a normal Ambio turn', async t => {
  const f = fixture(t)
  const run = await f.runner.start({ ...f.input, mode: 'ask', codex: { review: true } })
  await wait(f.runner, run.key, run => run.state === 'completed')
  assert.equal(f.captured().review.target.type, 'uncommittedChanges')
  assert.match(f.captured().prompt, /Fixture native review found no issues/)
  assert.ok(f.runner.events('ws', run.key).some(e => e.output === 'check passed'))
})

test('legacy receipts pin their conversation to exec', async t => {
  const f = fixture(t)
  fs.mkdirSync(f.directory)
  fs.writeFileSync(path.join(f.directory, `${'a'.repeat(64)}.json`), JSON.stringify({ ...f.input, state: 'completed', key: 'a'.repeat(64), startedAt: 1, codexTransport: undefined }))
  assert.equal(f.runner.codexTransport('ws', 'conversation'), 'exec')
  assert.equal(f.runner.codexTransport('ws', 'new'), undefined)
})

test('a worktree handoff distinguishes shared project identity from the checkout to edit', () => {
  const project = path.resolve('project'), checkout = path.resolve('agent-checkout')
  const prompt = workOrderHandoff('Fixture', 'workspace', project, 'request', { checkoutPath: checkout })
  assert.ok(prompt.includes(`project "Fixture" (${project})`))
  assert.ok(prompt.includes(`Git worktree at ${checkout}`))
  assert.ok(prompt.includes('get_inbox reports that shared project root, which is expected'))
  assert.ok(prompt.includes('expectedWorkspaceId "workspace"'))
})
