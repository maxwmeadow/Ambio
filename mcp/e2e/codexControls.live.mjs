// Opt-in installed-CLI qualification. All commands, MCP peers and model work use scratch folders.
// AMBIO_LIVE_CODEX_CONTROLS=1 node --test mcp/e2e/codexControls.live.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { CodexAppServer, codexAppServerPolicy } from '../../electron/codexAppServer.ts'
import { DeliveryRunner, findDeliveryCli } from '../../electron/agentDelivery.ts'
import { agentDriver } from '../../electron/agentDrivers.ts'
import { codexAvailableAccess, inspectCodex } from '../../electron/agentModels.ts'
import { startHarness, harnessFetch } from './mcpHarness.mjs'
import { fileURLToPath } from 'node:url'

const enabled = process.env.AMBIO_LIVE_CODEX_CONTROLS === '1'
const policy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
const connections = new WeakMap()

test('installed Codex discovery returns cold access immediately and qualifies the initialized version on refresh', { skip: !enabled, timeout: 30000 }, async () => {
  const launcher = findDeliveryCli('codex'); assert.ok(launcher)
  const start = performance.now()
  assert.deepEqual(codexAvailableAccess(launcher), ['ask', 'full'])
  const elapsed = performance.now() - start
  assert.ok(elapsed < 1000, `host access blocked for ${elapsed}ms`)
  const found = await inspectCodex(launcher)
  assert.deepEqual(codexAvailableAccess(launcher), ['ask', 'auto', 'full'])
  assert.equal(codexAppServerPolicy('build', 'on-request', process.platform, 'auto_review', found.userAgent).sandbox, 'workspace-write')
  console.log(`Discovery: cold host access ${Math.round(elapsed)}ms; refresh qualified ${found.userAgent}`)
})
function scratch(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await Promise.all((connections.get(t) ?? []).map(close => close()))
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return root
}
function connect(t, cwd, args, options = {}) {
  const launcher = findDeliveryCli('codex'); assert.ok(launcher)
  const events = [], messages = []
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT
  const child = spawn(launcher.command, [...launcher.args, ...args], { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  const client = new CodexAppServer({ cwd, prompt: '', mode: 'build', send: line => child.stdin.write(`${line}\n`), onSession: () => {}, onEvent: event => events.push(event), ...options })
  let pending = '', stderr = ''; const decoder = new StringDecoder('utf8')
  child.stdout.on('data', chunk => { pending += decoder.write(chunk); const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) { try { messages.push(JSON.parse(line)) } catch {} client.receive(line) } })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000) })
  child.stdin.on('error', () => {})
  child.on('error', error => client.close(error.message))
  child.on('close', () => client.close(stderr || 'Codex exited'))
  const close = async () => {
    client.close(); child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise(resolve => child.once('close', resolve))
    let timer
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500) })]) } finally { clearTimeout(timer) }
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
  }
  connections.set(t, [...(connections.get(t) ?? []), close])
  return { client, events, messages }
}

test('installed Codex asks a structured question and receives the users answer or refusal', { skip: !enabled, timeout: 300000 }, async t => {
  const cwd = scratch(t, 'ambio-codex-questions-')
  for (const deny of [false, true]) {
    let asked = 0
    const f = connect(t, cwd, ['app-server', '-c', 'mcp_servers={}', '-c', 'features.default_mode_request_user_input=true'], {
      mode: 'ask', model: process.env.AMBIO_LIVE_CONVERSATION_MODEL || 'gpt-6-luna',
      prompt: 'This is an interactive protocol test. Call request_user_input now with exactly one question: "Which marker should I report?" and choices ORCHID and AMBER. Wait for the actual answer. Do not use tools other than request_user_input, do not read or edit files, and do not guess the answer. After the answer, report it; if the user declines, report that they declined and stop.',
      approve: async question => {
        assert.equal(question.kind, 'question'); asked++
        return deny ? false : { answers: Object.fromEntries(question.questions.map(q => [q.question, 'ORCHID'])) }
      },
    })
    const result = await f.client.run()
    assert.ok(asked > 0, JSON.stringify(f.events))
    assert.equal(result.stopReason, 'completed')
    if (deny) assert.ok(f.messages.some(message => message.method === 'serverRequest/resolved'), JSON.stringify(f.messages.filter(message => message.method === 'item/tool/requestUserInput')))
    else assert.ok(f.events.some(event => event.kind === 'text' && event.text.includes('ORCHID')), JSON.stringify(f.events))
    console.log(`Structured input: ${deny ? 'declined' : 'answered ORCHID'}; requests=${asked}; final=${f.events.filter(event => event.kind === 'text').at(-1)?.text}`)
  }
})

test('installed Codex questions wait on the real permission desk and are released after answering or denying', { skip: !enabled, timeout: 300000 }, async t => {
  const directory = scratch(t, 'ambio-codex-question-desk-')
  const saved = { ...process.env }, h = await startHarness()
  const runner = new DeliveryRunner(directory)
  try {
    process.env.AMBIO_API_URL = h.apiBase
    process.env.AMBIO_API_TOKEN = 'ambio-isolated-test-token-for-mcp-harness'
    process.env.AMBIO_ACTIVE_PROJECT = h.activeProjectPath
    delete process.env.ELECTRON_RUN_AS_NODE
    for (const decision of ['answer', 'deny']) {
      const messageId = `question-${decision}`
      const run = await runner.start({ workspaceId: h.workspaceId, messageId, hostId: 'codex', rootPath: h.projectDir, revision: 'initial', launcher: findDeliveryCli('codex'), args: ['app-server', '-c', 'mcp_servers={}', '-c', 'features.default_mode_request_user_input=true'], mode: 'ask', codexTransport: 'app-server', codex: { model: process.env.AMBIO_LIVE_CONVERSATION_MODEL || 'gpt-6-luna' }, prompt: 'Call request_user_input exactly once with a question "Which marker?" and two choices ORCHID and AMBER. Wait for the answer. Do not call any other tools, or read or write files. Report the actual answer afterward; if there is no answer or the request fails, stop without guessing.' })
      const requests = async () => (await (await harnessFetch(`${h.apiBase}/api/agent/permission?workspace=${h.workspaceId}`)).json()).requests
      let question
      for (let i = 0; i < 900; i++) {
        question = (await requests()).find(request => request.messageId === messageId)
        if (question) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.ok(question?.questions?.length, JSON.stringify(runner.events(h.workspaceId, run.key)))
      assert.equal(question.expiresAt - question.askedAt, 600000)
      assert.equal((await harnessFetch(`${h.apiBase}/api/agent/permission/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: h.workspaceId, id: question.id, decision, ...(decision === 'answer' ? { answers: Object.fromEntries(question.questions.map(q => [q.question, 'ORCHID'])) } : {}) }) })).status, 200)
      let final
      for (let i = 0; i < 900; i++) {
        final = runner.list(h.workspaceId).find(item => item.key === run.key)
        if (!['starting', 'running', 'stopping'].includes(final.state)) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(final.state, 'completed', final.detail)
      if (decision === 'answer') assert.ok(runner.events(h.workspaceId, run.key).some(event => event.kind === 'text' && event.text.includes('ORCHID')))
      assert.ok(!(await requests()).some(request => request.messageId === messageId))
      console.log(`Question desk: ${decision}; wait=600000ms; ${final.serverVersion}; turn completed and card cleared`)
    }
  } finally { await runner.stopAll(); h.stop(); process.env = saved }
})

test('installed Codex replaces inherited MCP for mapping and keeps it on ordinary runs', { skip: !enabled, timeout: 120000 }, async t => {
  const root = scratch(t, 'ambio-codex-isolation-')
  const peer = path.join(root, 'mcp.cjs')
  fs.writeFileSync(peer, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:process.argv[2],version:'1'}}:m.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`)
  const foreign = `mcp_servers={foreign={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(peer)},"foreign"]}}`
  for (const mapping of [false, true]) {
    const turn = { hostId: 'codex', workspaceId: 'scratch', mode: 'build', cwd: root, prompt: '', mcp: { command: process.execPath, args: [peer, 'ambio'] }, ...(mapping ? { mapping: { attempt: { id: 'scratch-attempt' }, token: 'ambio-map.scratch-isolation-credential' }, messageId: 'mapping' } : {}) }
    const args = agentDriver('codex').appServerArgs(turn)
    const f = connect(t, root, [args[0], '-c', foreign, ...args.slice(1)])
    await f.client.initialize()
    // Raw protocol inspection deliberately creates no model turn and invokes no MCP tool.
    await f.client.request('thread/start', { cwd: root, sandbox: 'danger-full-access', approvalPolicy: 'never' })
    const result = await f.client.request('mcpServerStatus/list', { limit: 100 })
    console.log(`MCP observed ${mapping ? 'mapping' : 'ordinary'}: ${JSON.stringify(result.data.map(server => ({ name: server.name, runtime: server.runtimeStatus, tools: Object.keys(server.tools ?? {}).length })))}`)
    if (mapping) {
      const config = await f.client.request('config/read', { cwd: root, includeLayers: false })
      assert.deepEqual(Object.entries(config.config.mcp_servers).filter(([, server]) => server.enabled !== false).map(([name]) => name).sort(), ['ambio'])
      // Status discovery includes disabled entries; they must expose no tools.
      assert.ok(result.data.filter(server => server.name !== 'ambio').every(server => Object.keys(server.tools ?? {}).length === 0))
      assert.ok(!result.data.some(server => server.name === 'foreign'))
    }
    else assert.ok(result.data.some(server => server.name === 'foreign'))
    console.log(`MCP ${mapping ? 'mapping' : 'ordinary'}: ${result.data.map(server => server.name).join(', ')}`)
    f.client.close()
  }
})

test('installed Codex sandbox blocks outside writes; Ask me denies and Auto reviews a harmless escalation', { skip: !enabled, timeout: 600000 }, async t => {
  const root = scratch(t, 'ambio-codex-controls-')
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd)
  const args = ['app-server', '-c', 'mcp_servers={}', ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : [])]
  const raw = connect(t, cwd, args)
  await raw.client.initialize()
  const inside = path.join(cwd, 'inside.txt'), denied = path.join(root, 'denied.txt')
  const exec = file => raw.client.request('command/exec', { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(file)},'fixture')`], cwd, sandboxPolicy: { ...policy, writableRoots: [cwd] }, timeoutMs: 10000 })
  assert.equal((await exec(inside)).exitCode, 0)
  await assert.rejects(exec(denied), /EPERM|EACCES|denied|permitted/i)
  assert.equal(fs.existsSync(denied), false)
  const readOnly = path.join(cwd, 'read-only-denied.txt')
  await assert.rejects(raw.client.request('command/exec', { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(readOnly)},'fixture')`], cwd, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 10000 }), /EPERM|EACCES|denied|permitted/i)
  assert.equal(fs.existsSync(readOnly), false)
  console.log('Sandbox: inside write succeeds for Build; outside writes and read-only profile writes are blocked.')
  const model = process.env.AMBIO_LIVE_CONVERSATION_MODEL || 'gpt-6-luna'
  for (const reviewer of ['user', 'auto_review']) {
    const marker = path.join(root, `${reviewer}.txt`)
    let asks = 0, server
    const f = connect(t, cwd, args, { approval: 'on-request', reviewer, model,
      onServer: value => { server = value },
      approve: async () => { asks++; return false },
      prompt: `This is an authorized harmless protocol test. Use exec_command with sandbox_permissions=require_escalated and a justification to write only the string OK to ${JSON.stringify(marker)} using the shell. The path is outside the workspace on purpose. Do not retry, work around a refusal, or touch any other file. After this single attempt, report the result.`,
    })
    assert.equal((await f.client.run()).stopReason, 'completed')
    if (reviewer === 'user') { assert.ok(asks > 0); assert.equal(fs.existsSync(marker), false) }
    else { assert.equal(asks, 0); assert.ok(f.events.some(event => event.text.startsWith('Auto review ·')), JSON.stringify(f.events)); assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'OK') }
    console.log(`${reviewer}: ${server}; manual callbacks=${asks}; reviews=${f.events.filter(event => event.text.startsWith('Auto review ·')).map(event => event.text).join(' | ')}`)
    assert.equal(codexAppServerPolicy('build', 'on-request', process.platform, reviewer, server).sandbox, 'workspace-write')
  }
})

test('installed Codex attributes a real read-only child agent', { skip: !enabled, timeout: 600000 }, async t => {
  const cwd = scratch(t, 'ambio-codex-subagent-')
  fs.writeFileSync(path.join(cwd, 'marker.txt'), 'ORCHID')
  const f = connect(t, cwd, ['app-server', '-c', 'mcp_servers={}', '-c', 'features.multi_agent=true'], {
    model: process.env.AMBIO_LIVE_CONVERSATION_MODEL || 'gpt-6-luna',
    prompt: 'Spawn exactly one read-only child agent to read marker.txt in this directory and report its word. Wait for its result and report the word. Do not edit any file. This test specifically requires a child agent, not reading it yourself.',
  })
  assert.equal((await f.client.run()).stopReason, 'completed')
  const children = f.events.filter(event => event.text.startsWith('Subagent ·'))
  assert.ok(children.length > 0, JSON.stringify(f.events))
  assert.ok(f.events.some(event => event.kind === 'text' && event.text.includes('ORCHID')))
  console.log(`Child activity: ${children.map(event => event.text).join(' | ')}`)
})

test('installed Codex submits a finite scoped mapping with only Ambio MCP enabled', { skip: !enabled, timeout: 300000 }, async () => {
  const saved = { ...process.env }
  const h = await startHarness()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-codex-mapping-live-'))
  const runner = new DeliveryRunner(directory)
  try {
    process.env.AMBIO_API_URL = h.apiBase
    process.env.AMBIO_API_TOKEN = 'ambio-isolated-test-token-for-mcp-harness'
    process.env.AMBIO_ACTIVE_PROJECT = h.activeProjectPath
    delete process.env.ELECTRON_RUN_AS_NODE
    const post = (route, body) => harnessFetch(`${h.apiBase}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: h.workspaceId, ...body }) })
    const id = 'native-mapping'
    assert.equal((await post('/api/canvas/send', { id, mode: 'propose', deliveryMode: 'addressed', note: 'This is a mapping request. Map only.' })).status, 200)
    const made = await post('/api/mapping-attempts', { messageId: id }); assert.equal(made.status, 200)
    const mapping = await made.json()
    const mcp = { command: process.execPath, args: [fileURLToPath(new URL('../ambio-mcp.ts', import.meta.url))] }
    const driver = agentDriver('codex'), model = process.env.AMBIO_LIVE_CONVERSATION_MODEL || 'gpt-6-luna'
    const prompt = `This is a finite onboarding mapping session for workspace ${h.workspaceId}. Call get_architecture to find the six fixture source files. Use edit_systems begin_session, add_chunk and commit_session to map Storage (all storage/*.py files) and API (all api/*.py files), with short responsibilities. Read only; do not edit files, draw sheets, start work sessions or reply to a work order. Use the scoped mapping tools, not local databases or HTTP. Committing is the final action and closes the session automatically.`
    const args = driver.appServerArgs({ hostId: 'codex', workspaceId: h.workspaceId, mode: 'propose', cwd: h.projectDir, prompt, messageId: id, mapping, mcp, model })
    args.push('-c', `mcp_servers.ambio.env.AMBIO_API_URL=${JSON.stringify(h.apiBase)}`, '-c', `mcp_servers.ambio.env.AMBIO_ACTIVE_PROJECT=${JSON.stringify(h.activeProjectPath)}`)
    const run = await runner.start({ workspaceId: h.workspaceId, messageId: id, hostId: 'codex', revision: 'initial', rootPath: h.projectDir, launcher: findDeliveryCli('codex'), args, prompt, mode: 'propose', driver, mapping, codexTransport: 'app-server', codex: { model } })
    let final
    for (let i = 0; i < 2400; i++) {
      final = runner.list(h.workspaceId).find(item => item.key === run.key)
      if (!['starting', 'running', 'stopping'].includes(final.state)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(final.state, 'completed', `${final.detail}\n${JSON.stringify(runner.events(h.workspaceId, run.key))}`)
    const attempt = await (await harnessFetch(`${h.apiBase}/api/mapping-attempts/${mapping.attempt.id}?workspace=${h.workspaceId}`)).json()
    assert.equal(attempt.state, 'submitted'); assert.ok(attempt.endedAt)
    console.log(`Finite mapping: submitted and process closed; ${final.serverVersion}; ${runner.events(h.workspaceId, run.key).filter(event => event.kind === 'tool').map(event => event.text).join(' | ')}`)
  } finally {
    await runner.stopAll(); h.stop(); process.env = saved
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
