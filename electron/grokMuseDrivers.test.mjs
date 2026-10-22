import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { AcpClient } from './acpClient.ts'
import { DeliveryRunner, deliveryPlan, deliveryTargets, findDeliveryCli } from './agentDelivery.ts'
import { agentDriver } from './agentDrivers.ts'
import { listModels } from './agentModels.ts'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambio-vendor-drivers-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return root
}
function testSpawn(command, args, options) {
  const env = { ...options.env }; delete env.NODE_TEST_CONTEXT
  return spawn(command, args, { ...options, env })
}
async function settled(runner, key) {
  for (let tries = 0; tries < 600; tries++) {
    const run = runner.list('ws').find(run => run.key === key)
    if (['completed', 'failed', 'stopped'].includes(run?.state)) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('protocol run did not settle')
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: native Grok home and Muse PATH become runnable without global MCP setup`, t => {
    const root = fixture(t)
    const grokBin = path.join(root, 'custom-grok-home', 'bin')
    const museBin = path.join(root, 'tools')
    for (const [dir, name] of [[grokBin, 'grok'], [museBin, 'muse']]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name + (platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 })
    }
    const env = { PATH: museBin, GROK_HOME: path.dirname(grokBin) }
    assert.equal(findDeliveryCli('grok', env, platform, root).command, path.join(grokBin, platform === 'win32' ? 'grok.exe' : 'grok'))
    const targets = deliveryTargets(['grok', 'muse'].map(id => ({ id, label: id })), env, platform, root)
    assert.ok(targets.every(target => target.available && target.route === 'run'))
  })
}

for (const methodId of ['cached_token', 'xai.api_key', 'grok.com']) {
  test(`Grok authenticates with advertised ${methodId} before attaching the per-run MCP server`, async () => {
    const requests = [], events = []
    let client
    const server = { name: 'ambio', command: 'archd', args: ['mcp-run', '--ambio-host=grok'], env: [{ name: 'AMBIO_WORKSPACE_ID', value: 'ws' }, { name: 'AMBIO_RUN_MESSAGE_ID', value: 'turn' }] }
    client = new AcpClient({
      cwd: os.tmpdir(), prompt: 'Claim turn', mode: 'build', authentication: 'grok', mcpServers: [server], onSession() {}, onEvent: event => events.push(event),
      send: line => {
        const request = JSON.parse(line); requests.push(request)
        const result = request.method === 'initialize' ? { authMethods: [{ id: methodId }], agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'native-session' } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        queueMicrotask(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })))
      },
    })
    // The API method is offered by some builds; no credential value is inspected or logged.
    const previous = process.env.XAI_API_KEY
    if (methodId === 'xai.api_key') process.env.XAI_API_KEY = 'fixture-only'
    try {
      assert.equal((await client.run()).stopReason, 'end_turn')
      assert.deepEqual(requests.map(request => request.method), ['initialize', 'authenticate', 'session/new', 'session/prompt'])
      assert.equal(requests[1].params.methodId, methodId)
      assert.equal(requests[1].params._meta.headless, true)
      assert.deepEqual(requests[2].params.mcpServers, [server])
    } finally { client.close(); if (previous === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previous }
  })
}

test('Grok authentication failure is actionable and never submits a prompt', async () => {
  let client
  const methods = []
  client = new AcpClient({ cwd: os.tmpdir(), prompt: 'p', mode: 'build', authentication: 'grok', mcpServers: [], onSession() {}, onEvent() {}, send: line => {
    const request = JSON.parse(line); methods.push(request.method)
    queueMicrotask(() => client.receive(JSON.stringify({ id: request.id, ...(request.method === 'initialize' ? { result: { authMethods: [{ id: 'grok.com' }] } } : { error: { message: 'Not signed in' } }) })))
  } })
  await assert.rejects(client.run(), /Run grok login/)
  assert.deepEqual(methods, ['initialize', 'authenticate'])
  client.close()
})

// A strict protocol peer based on Meta's published MSP v1 schema. This is
// contract coverage, not a signed-in native Muse trial (see *.live.mjs).
const MUSE_PEER = `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const lines = require('node:readline').createInterface({ input: process.stdin })
const send = msg => console.log(JSON.stringify({ jsonrpc:'2.0', ...msg }))
let sessionId, turnId, initialized = false
lines.on('line', line => {
  const {id, method, params} = JSON.parse(line)
  fs.appendFileSync('requests.jsonl', line+'\\n')
  if (method === 'initialize') return send({id,result:{schema:{version:1}}})
  if (method === 'initialized') { initialized = true; return }
  assert.ok(initialized)
  if (method === 'model/list') return send({id,result:{models:[{modelId:'muse-model',displayLabel:'Muse Model'}]}})
  assert.match(params.commandId, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  if (method === 'session/resume' && params.sessionId === 'gone') return send({id,error:{code:-32011,message:'Session not found'}})
  if (method === 'session/start' || method === 'session/resume') {
    const server = params.config.mcpServers.ambio
    assert.equal(server.transport,'stdio'); assert.equal(server.env.AMBIO_RUN_MESSAGE_ID,'turn')
    assert.ok(server.args.includes('--ambio-host=muse'))
    sessionId = method === 'session/resume' ? params.sessionId : '0198f0aa-1111-7000-8000-0000000000aa'
    if (method === 'session/start') assert.equal(params.approvalMode,'allowAll')
    return send({id,result:{session:{sessionId,workspaceRoot:process.env.WRONG_ROOT ? '/different-project' : process.cwd()},pendingRequests:process.env.PENDING ? [{kind:'approval'}] : [],viewCursor:'v1:head'}})
  }
  if (method === 'session/setModel') { assert.deepEqual(params.model,{modelId:'muse-model'}); return send({id,result:{status:'accepted'}}) }
  if (method === 'session/setApprovalMode') { assert.equal(params.mode,'allowAll'); return send({id,result:{status:'accepted'}}) }
  if (method === 'turn/interrupt') return send({id,result:{status:'accepted'}})
  assert.equal(method,'turn/start')
  assert.equal(params.input[0].type,'text')
  turnId = process.env.ACK_LATE ? '0198f0aa-1111-7000-8000-0000000000bb' : params.commandId
  if (process.env.EARLY_EXIT) return process.exit(0)
  const ack=()=>send({id,result:{status:'accepted',turnId,disposition:'started'}})
  if(!process.env.ACK_LATE) ack()
  if (process.env.WAIT_FOR_STOP) return
  if (process.env.INTERACTIVE) return send({method:'approval/requested',params:{sessionId,turnId}})
  send({method:'item/completed',params:{sessionId:'another-session',item:{itemId:'foreign',kind:'agentMessage',text:'Ignore this'}}})
  send({method:'item/started',params:{sessionId,item:{itemId:'t',turnId,kind:'toolCall',toolName:'ambio.get_inbox'}}})
  send({method:'item/completed',params:{sessionId,item:{itemId:'t',turnId,kind:'toolCall',toolName:'ambio.get_inbox'}}})
  send({method:'item/started',params:{sessionId,item:{itemId:'a',turnId,kind:'agentMessage',text:''}}})
  send({method:'item/delta',params:{sessionId,itemId:'a',delta:'Done.'}})
  send({method:'item/completed',params:{sessionId,item:{itemId:'a',turnId,kind:'agentMessage',text:'Done.'}}})
  send({method:'turn/completed',params:{sessionId,turnId,terminal:process.env.TERMINAL || 'completed'}})
  if(process.env.ACK_LATE) ack()
})
lines.on('close',()=>process.exit(0))
`
function museTurn(root, resume) {
  const script = path.join(root, 'muse-peer.cjs'); fs.writeFileSync(script, MUSE_PEER)
  const plan = deliveryPlan('muse', { command: 'archd', args: [] }, 'ws', 'Claim turn', { mode: 'ask' })
  return { workspaceId: 'ws', messageId: 'turn', hostId: 'muse', rootPath: root, revision: 'initial', threadId: 'thread', mode: 'ask', prompt: 'Claim turn', driver: agentDriver('muse'), launcher: { command: process.execPath, args: [script] }, args: plan.args,
    muse: { resume, model: 'muse-model', mcpServers: [{ name: 'ambio', command: 'archd', args: ['mcp-run', '--ambio-host=muse'], env: [{ name: 'AMBIO_WORKSPACE_ID', value: 'ws' }, { name: 'AMBIO_RUN_MESSAGE_ID', value: 'turn' }] }] } }
}
for (const resume of [undefined, 'known', 'gone']) {
  test(`Muse sessions bind the workspace, request and model, then finish (resume: ${resume})`, async t => {
    const root = fixture(t)
    const runner = new DeliveryRunner(path.join(root, 'runs'), testSpawn)
    const run = await settled(runner, (await runner.start(museTurn(root, resume))).key)
    assert.equal(run.state, 'completed', run.detail)
    assert.equal(run.resumed, resume === 'known')
    assert.equal(runner.session('ws', 'thread', 'muse'), run.sessionId)
    assert.deepEqual(runner.events('ws', run.key).map(event => [event.kind,event.text]), [['tool','ambio.get_inbox'],['text','Done.']])
    const requests = fs.readFileSync(path.join(root,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    const start = requests.find(request => request.method === 'session/start')
    if (start) assert.equal(start.params.modelId, 'muse-model')
    else assert.ok(requests.some(request => request.method === 'session/setModel'))
  })
}
for (const [setting, value, expected] of [['PENDING','1',/interactive request pending/], ['WRONG_ROOT','1',/different project/], ['EARLY_EXIT','1',/exited/], ['INTERACTIVE','1',/interactive approval/], ['TERMINAL','failed',/stopped early/]]) {
  test(`Muse ${setting} cannot be mistaken for a successful turn`, async t => {
    const root = fixture(t)
    const runner = new DeliveryRunner(path.join(root, 'runs'), (command,args,options) => testSpawn(command,args,{...options,env:{...options.env,[setting]:value}}))
    const run = await settled(runner,(await runner.start(museTurn(root))).key)
    assert.equal(run.state,'failed')
    assert.match(run.detail, expected)
  })
}
test('Muse Stop interrupts the protocol turn and closes its process', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root,'runs'), (command,args,options) => testSpawn(command,args,{...options,env:{...options.env,WAIT_FOR_STOP:'1'}}))
  const started = await runner.start(museTurn(root))
  for (let tries=0; tries<100 && !runner.session('ws','thread','muse'); tries++) await new Promise(resolve=>setTimeout(resolve,10))
  runner.stop('ws',started.key)
  assert.equal((await settled(runner,started.key)).state,'stopped')
})
test('Muse model discovery uses MSP without creating a session', async t => {
  const root = fixture(t)
  const script = path.join(root,'models.cjs')
  fs.writeFileSync(script, `const lines=require('node:readline').createInterface({input:process.stdin}); lines.on('line',line=>{const {id,method}=JSON.parse(line); if(method==='initialized')return; if(!['initialize','model/list'].includes(method))process.exit(3); console.log(JSON.stringify({id,result:method==='initialize'?{schema:{version:1}}:{models:[{modelId:'muse-model',displayLabel:'Muse Model'}]}}))}); lines.on('close',()=>process.exit(0))`)
  assert.deepEqual(await listModels('muse',{command:process.execPath,args:[script]},root),[{id:'muse-model',label:'Muse Model'}])
})

test('Muse uses the acknowledged turn ID even when events precede the ack', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'runs'), (command, args, options) => testSpawn(command, args, { ...options, env: { ...options.env, ACK_LATE: '1' } }))
  const run = await settled(runner, (await runner.start(museTurn(root))).key)
  assert.equal(run.state, 'completed', run.detail)
  assert.deepEqual(runner.events('ws', run.key).map(event => event.text), ['ambio.get_inbox', 'Done.'])
})
