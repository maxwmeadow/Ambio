// Opt-in real host trial of a conversation. No developer project or global
// host config is changed: archd, the project and the MCP binding are the
// isolated harness's. It does spend a little of the host account's usage.
//
//   AMBIO_LIVE_CONVERSATION_HOST=claude-code node --test mcp/e2e/conversation.live.mjs
//
// Hosts: claude-code, codex, copilot-cli, cursor-cli, devin-cli,
// antigravity-cli, antigravity-acp, grok, muse. The host's CLI must be installed and
// signed in.
//
// What it proves that stand-in agents cannot: the real CLI accepts what its
// driver passes, claims the turn and replies through Ambio's tools, is given
// the conversation so far, continues its own session where it can, is held
// to the turn's mode, and gets a usable answer when it asks permission.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'
import { DeliveryRunner, deliveryPlan, findDeliveryCli } from '../../electron/agentDelivery.ts'
import { agentDriver } from '../../electron/agentDrivers.ts'
import { workOrderHandoff } from '../../src/shared/workOrderHandoff.ts'

const host = process.env.AMBIO_LIVE_CONVERSATION_HOST
const driver = host ? agentDriver(host) : undefined
const MCP_ENTRY = fileURLToPath(new URL('../ambio-mcp.ts', import.meta.url))
const TOKEN = 'ambio-isolated-test-token-for-mcp-harness'
// A cheaper model is enough to follow a handoff; set to '' for the host's default.
const model = process.env.AMBIO_LIVE_CONVERSATION_MODEL ?? (host === 'claude-code' ? 'haiku' : '')

function sourceFiles(root) {
  const files = {}
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__pycache__') visit(target)
      else if (entry.isFile()) files[path.relative(root, target)] = fs.readFileSync(target, 'utf8')
    }
  }
  visit(root)
  return files
}

test(`a real ${host ?? 'host'} holds a conversation through Ambio`, { skip: !driver && 'set AMBIO_LIVE_CONVERSATION_HOST to a driven host', timeout: 1500000 }, async t => {
  const harness = await startHarness()
  t.after(() => harness.stop())
  // The MCP server the host starts must reach this harness, not a running Ambio.
  const binding = { AMBIO_API_URL: harness.apiBase, AMBIO_API_TOKEN: TOKEN, AMBIO_ACTIVE_PROJECT: harness.activeProjectPath }
  Object.assign(process.env, binding)
  delete process.env.ELECTRON_RUN_AS_NODE
  const launcher = findDeliveryCli(host)
  assert.ok(launcher, `${host} is not installed`)
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-live-runs-'))
  t.after(() => fs.rmSync(runs, { recursive: true, force: true }))
  const runner = new DeliveryRunner(runs)
  t.after(() => runner.stopAll())
  const mcp = { command: process.execPath, args: [MCP_ENTRY] }
  // A host that only reads its own config files is given one inside the
  // throwaway project, never in the developer's home.
  if (host === 'antigravity-cli') {
    fs.mkdirSync(path.join(harness.projectDir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(harness.projectDir, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { ambio: {
      command: mcp.command, args: [...mcp.args, `--ambio-host=${host}`], env: { ...binding, AMBIO_WORKSPACE_ID: harness.workspaceId },
    } } }))
  }
  const before = sourceFiles(harness.projectDir)

  const history = async id => {
    const response = await fetch(`${harness.apiBase}/api/canvas/history?workspace=${encodeURIComponent(harness.workspaceId)}`)
    return (await response.json()).messages.find(message => message.id === id)
  }
  // Stands in for the user: allows whatever the agent asks, and remembers it.
  const asked = []
  let answering = true
  const answer = (async () => {
    while (answering) {
      try {
        const { requests } = await (await fetch(`${harness.apiBase}/api/agent/permission?workspace=${encodeURIComponent(harness.workspaceId)}`)).json()
        for (const request of requests) {
          asked.push(request)
          await fetch(`${harness.apiBase}/api/agent/permission/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: harness.workspaceId, id: request.id, decision: 'allow' }) })
        }
      } catch { /* the harness is stopping */ }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  })()
  t.after(async () => { answering = false; await answer })

  // The same decisions electron/main.ts makes for a delivery.
  const turn = async (id, mode, note) => {
    const sent = await fetch(`${harness.apiBase}/api/canvas/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, workspaceId: harness.workspaceId, deliveryMode: 'addressed', threadId: 'live-ask', mode, note }),
    })
    assert.equal(sent.status, 200, await sent.text())
    const prompt = workOrderHandoff('harness', harness.workspaceId, harness.projectDir, id)
    const resume = driver.resumable ? runner.session(harness.workspaceId, 'live-ask', host) : undefined
    // Codex starts MCP servers with only the environment it is given, so the
    // harness's address goes into the server's config (a running Ambio needs
    // none: the server finds it by its default port and token file).
    const harnessEnv = host === 'codex' ? Object.entries(binding).flatMap(([name, value]) => ['-c', `mcp_servers.ambio.env.${name}=${JSON.stringify(value)}`]) : []
    const withHarness = args => harnessEnv.length && args.at(-1) === '-' ? [...args.slice(0, -1), ...harnessEnv, '-'] : [...args, ...harnessEnv]
    const print = () => { const plan = deliveryPlan(host, mcp, harness.workspaceId, prompt, { mode, messageId: id, cwd: harness.projectDir, model: model || undefined }); return { ...plan, args: withHarness(plan.args) } }
    const session = driver.acp || driver.acpArgs || driver.muse
    const acp = session ? {
      resume,
      mcpServers: [{ name: 'ambio', command: mcp.command, args: [...mcp.args, `--ambio-host=${host}`], env: Object.entries({ ...binding, AMBIO_WORKSPACE_ID: harness.workspaceId, AMBIO_RUN_MESSAGE_ID: id }).map(([name, value]) => ({ name, value })) }],
      askUser: async question => {
        const response = await fetch(`${harness.apiBase}/api/agent/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: harness.workspaceId, messageId: id, hostId: host, ...question }) })
        return (await response.json()).decision === 'allow'
      },
    } : undefined
    const plan = driver.acpArgs ? { args: driver.acpArgs({ hostId: host, mcp, workspaceId: harness.workspaceId, prompt, mode, messageId: id, cwd: harness.projectDir, model: model || undefined }) } : session ? deliveryPlan(host, mcp, harness.workspaceId, prompt, { mode, messageId: id, cwd: harness.projectDir, model: model || undefined }) : (() => { const made = deliveryPlan(host, mcp, harness.workspaceId, prompt, { mode, resume, messageId: id, cwd: harness.projectDir, model: model || undefined }); return { ...made, args: withHarness(made.args) } })()
    const started = await runner.start({
      workspaceId: harness.workspaceId, messageId: id, hostId: host, rootPath: harness.projectDir, revision: 'initial', launcher, prompt,
      args: plan.args, stdin: plan.stdin, threadId: 'live-ask', mode, driver, sessionId: resume ?? plan.sessionId, resumed: !!resume,
      ...(acp ? driver.muse ? { muse: { ...acp, model: model || undefined } } : { acp } : {}), ...(driver.acp || driver.muse ? {} : { fresh: print }),
    })
    let run
    for (let waited = 0; waited < 420; waited++) {
      run = runner.list(harness.workspaceId).find(item => item.key === started.key)
      if (['completed', 'failed', 'launch-failed', 'stopped'].includes(run?.state)) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const events = runner.events(harness.workspaceId, started.key)
    const message = await history(id)
    const output = () => `${run?.state}: ${run?.detail}\nevents: ${JSON.stringify(events.map(event => event.text))}\nlog tail: ${fs.readFileSync(run.logPath, 'utf8').slice(-2500)}`
    assert.equal(run?.state, 'completed', output())
    assert.equal(message?.status, 'answered', `the agent never replied through Ambio.\n${output()}`)
    if (host === 'grok' || host === 'muse') {
      const presence = await (await fetch(`${harness.apiBase}/api/agent/presence?workspace=${encodeURIComponent(harness.workspaceId)}`)).json()
      assert.ok(presence.connections.some(connection => connection.hostId === host && connection.lastToolAt > 0), `missing ${host} attribution`)
    }
    console.log(`\n[${mode}] ${note}\n  -> ${message.reply.body.replace(/\s+/g, ' ').slice(0, 300)}\n  session ${run.sessionId ?? '(none)'}${run.resumed ? ' (continued)' : ''}\n  did: ${events.filter(event => event.kind === 'tool').map(event => event.text).join(' | ')}`)
    return { run, events, reply: message.reply.body }
  }

  // The fixture's task store is 'storage/task_store.py'.
  const first = await turn('live-ask', 'ask', 'Which file defines the TaskStore class? Reply with its path only.')
  assert.match(first.reply, /task_store\.py/)
  assert.deepEqual(sourceFiles(harness.projectDir), before, 'a question changed files')

  // The second turn only makes sense with the first: nothing in it names the file.
  const second = await turn('live-ask-2', 'ask', 'In the file you just named, which method returns its argument unchanged? Reply with the method name only.')
  assert.match(second.reply, /\bget\b/)
  console.log(`\n  session continued: ${second.run.resumed === true} (driver says it can: ${driver.resumable})`)
  if (['claude-code', 'grok', 'muse'].includes(host)) {
    assert.equal(second.run.resumed, true, 'the second turn did not continue the host session')
    assert.equal(second.run.sessionId, first.run.sessionId)
  }

  // Antigravity CLI's print mode refuses any command it cannot ask about and
  // ends the run there (agy 1.0.16). That is what the turn must say.
  if (host === 'antigravity-cli') {
    const sent = await fetch(`${harness.apiBase}/api/canvas/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'live-build', workspaceId: harness.workspaceId, deliveryMode: 'addressed', threadId: 'live-ask', mode: 'build', note: 'Run the shell command `node -e "console.log(6*7)"` and reply with exactly what it prints.' }) })
    assert.equal(sent.status, 200)
    const prompt = workOrderHandoff('harness', harness.workspaceId, harness.projectDir, 'live-build')
    const plan = deliveryPlan(host, mcp, harness.workspaceId, prompt, { mode: 'build', messageId: 'live-build', cwd: harness.projectDir })
    const started = await runner.start({ workspaceId: harness.workspaceId, messageId: 'live-build', hostId: host, rootPath: harness.projectDir, revision: 'initial', launcher, prompt, args: plan.args, stdin: plan.stdin, threadId: 'live-ask', mode: 'build', driver })
    let run
    for (let waited = 0; waited < 420 && !['completed', 'failed'].includes(run?.state); waited++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      run = runner.list(harness.workspaceId).find(item => item.key === started.key)
    }
    const said = runner.events(harness.workspaceId, started.key).map(event => event.text).join(' | ')
    console.log(`
[build] a command in Antigravity print mode -> ${run.state}: ${said}`)
    if (run.state === 'failed') assert.match(said, /"command" permission/)
    else assert.equal((await history('live-build'))?.status, 'answered')
    return
  }

  // A build wants a command that is neither one of its listed checks nor one
  // a host treats as harmless to run unasked.
  const third = await turn('live-build', 'build', 'Run the shell command `node -e "console.log(6*7)"` and reply with exactly what it prints. Do not create or edit any files.')
  console.log(`\n  questions put to the user: ${JSON.stringify(asked.map(request => [request.title, request.detail]))}`)
  assert.match(third.reply, /(^|[^0-9])42([^0-9]|$)/, 'the permitted command did not run')
  if (host === 'claude-code') assert.ok(asked.some(request => request.messageId === 'live-build' && /node -e/.test(request.detail ?? '')), `no question reached Ambio: ${JSON.stringify(asked)}`)
  assert.deepEqual(sourceFiles(harness.projectDir), before, 'the build changed files it was told not to')

  // A listed check runs without a question, in whichever shell the host uses.
  if (host === 'claude-code') {
    const questions = asked.length
    const fourth = await turn('live-build-2', 'build', 'Run the shell command `git status --short` in this folder and reply with one word: "ran" if the command executed (even if git reported an error), or "blocked" if you were not allowed to run it. Do not create or edit any files.')
    assert.match(fourth.reply, /ran/i)
    assert.equal(asked.length, questions, `a listed check was asked about: ${JSON.stringify(asked.slice(questions).map(request => request.detail))}`)
  }
})
