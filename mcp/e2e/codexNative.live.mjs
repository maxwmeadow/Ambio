// Opt-in authenticated native Codex journey, entirely inside a throwaway Git worktree.
// AMBIO_LIVE_CODEX_NATIVE=1 node --test mcp/e2e/codexNative.live.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { startHarness, harnessFetch } from './mcpHarness.mjs'
import { DeliveryRunner, findDeliveryCli } from '../../electron/agentDelivery.ts'
import { agentDriver } from '../../electron/agentDrivers.ts'
import { workOrderHandoff } from '../../src/shared/workOrderHandoff.ts'

test('authenticated native Codex coding, correction, approval, Stop, worktree resume and review', { skip: process.env.AMBIO_LIVE_CODEX_NATIVE !== '1', timeout: 900000 }, async () => {
  const saved = { ...process.env }
  const harness = await startHarness()
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-native-live-'))
  const checkout = path.join(runs, 'checkout')
  const runner = new DeliveryRunner(path.join(runs, 'receipts'))
  const launcher = findDeliveryCli('codex'), driver = agentDriver('codex')
  const model = process.env.AMBIO_LIVE_CONVERSATION_MODEL || 'gpt-6-luna'
  const binding = { AMBIO_API_URL: harness.apiBase, AMBIO_API_TOKEN: 'ambio-isolated-test-token-for-mcp-harness', AMBIO_ACTIVE_PROJECT: harness.activeProjectPath }
  Object.assign(process.env, binding)
  delete process.env.ELECTRON_RUN_AS_NODE
  const git = (...args) => execFileSync('git', args, { cwd: harness.projectDir, windowsHide: true, stdio: 'pipe' })
  let answering = true
  const asked = []
  const answerLoop = (async () => {
    while (answering) {
      const response = await harnessFetch(`${harness.apiBase}/api/agent/permission?workspace=${harness.workspaceId}`)
      for (const request of (await response.json()).requests) {
        asked.push(request)
        await harnessFetch(`${harness.apiBase}/api/agent/permission/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: harness.workspaceId, id: request.id, decision: 'allow' }) })
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })()
  try {
    assert.ok(launcher)
    git('init'); git('add', '.'); git('-c', 'user.name=Ambio fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture baseline')
    git('worktree', 'add', '-b', 'native-transport-smoke', checkout)
    const mcp = { command: process.execPath, args: [fileURLToPath(new URL('../ambio-mcp.ts', import.meta.url))] }
    const wait = async (run, condition) => {
      for (let i = 0; i < 1800; i++) {
        const current = runner.list(harness.workspaceId).find(item => item.key === run.key)
        if (condition(current)) return current
        if (['failed', 'launch-failed'].includes(current.state)) assert.fail(`${current.detail}\n${JSON.stringify(runner.events(harness.workspaceId, run.key))}`)
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.fail('Native Codex did not reach the expected state')
    }
    const start = async (id, mode, note, review = false) => {
      const response = await harnessFetch(`${harness.apiBase}/api/canvas/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, workspaceId: harness.workspaceId, threadId: 'native-code', deliveryMode: 'addressed', mode, note }) })
      assert.equal(response.status, 200, await response.text())
      const resume = runner.session(harness.workspaceId, 'native-code', 'codex')
      const prompt = workOrderHandoff('native fixture', harness.workspaceId, harness.projectDir, id, { checkoutPath: checkout })
      const args = driver.appServerArgs({ hostId: 'codex', workspaceId: harness.workspaceId, mcp, prompt, cwd: checkout, mode, messageId: id, model })
      args.push(...Object.entries(binding).flatMap(([name, value]) => ['-c', `mcp_servers.ambio.env.${name}=${JSON.stringify(value)}`]))
      return runner.start({ workspaceId: harness.workspaceId, messageId: id, hostId: 'codex', rootPath: checkout, revision: 'initial', launcher, args, prompt, driver, mode, threadId: 'native-code', resumed: !!resume, sessionId: resume, codexTransport: 'app-server', codex: { resume, model, approval: 'on-request', review } })
    }
    const finished = async run => {
      const current = await wait(run, run => run.state === 'completed')
      const response = await harnessFetch(`${harness.apiBase}/api/canvas/message?workspace=${harness.workspaceId}&messageId=${run.messageId}`)
      const message = await response.json()
      assert.equal(message.status, 'answered', `${JSON.stringify(message)}\n${JSON.stringify(runner.events(harness.workspaceId, run.key))}\nApprovals: ${JSON.stringify(asked)}`)
      assert.equal(current.rootPath, fs.realpathSync(checkout))
      console.log(`${run.messageId}: ${message.reply.body.slice(0, 500)}; resumed=${!!current.resumed}; ${current.serverVersion}`)
      return current
    }
    const code = await start('native-code', 'build', 'Create transport_probe.py with def answer(): returning integer 42. Use a shell command to create the file; this qualification uses Ask me so the host can approve that command. Do not draw or change architecture. Reply through Ambio after checking the file.')
    await wait(code, run => run.canSteer)
    await runner.steer(harness.workspaceId, code.key, 'Correction to this exact request: answer() must return integer 43, not 42. Keep the file name and the requested approval test.')
    const coded = await finished(code)
    assert.match(fs.readFileSync(path.join(checkout, 'transport_probe.py'), 'utf8'), /return\s+43/)
    assert.ok(asked.some(request => request.messageId === 'native-code'), 'No real Codex approval reached Ambio')
    const stopping = await start('native-stop', 'build', 'For Stop validation, start the shell command node -e "setTimeout(()=>console.log(42),30000)" and wait for it to finish. Do not edit files.')
    await wait(stopping, run => run.canSteer && runner.events(harness.workspaceId, run.key).some(event => event.kind === 'tool' && event.text.includes('setTimeout')))
    await runner.stop(harness.workspaceId, stopping.key)
    assert.equal(runner.list(harness.workspaceId).find(run => run.key === stopping.key).state, 'stopped')
    await harnessFetch(`${harness.apiBase}/api/canvas/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: harness.workspaceId, msgId: 'native-stop' }) })
    const review = await start('native-review', 'ask', 'Review the changes in this checkout without editing files. Return the native reviewer findings through Ambio.', true)
    const reviewed = await finished(review)
    assert.equal(reviewed.sessionId, coded.sessionId)
    assert.equal(reviewed.resumed, true)
    assert.ok(runner.events(harness.workspaceId, review.key).some(event => /review/i.test(event.text)))
    assert.equal(fs.existsSync(path.join(harness.projectDir, 'transport_probe.py')), false, 'The run escaped its worktree')
    console.log(`Real approval callbacks: ${asked.length}. Worktree identity and stopped-session review resume verified.`)
  } finally {
    answering = false; await answerLoop.catch(() => {}); await runner.stopAll(); harness.stop(); process.env = saved
    fs.rmSync(runs, { recursive: true, force: true })
  }
})
