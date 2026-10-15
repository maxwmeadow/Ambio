import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'

/**
 * A run Ambio started asks the user before doing something its turn did not
 * already allow. The host calls approve_action (Claude Code's
 * --permission-prompt-tool), the question waits in archd for the person to
 * answer it in the conversation, and the host gets back the JSON it expects.
 *
 * Runs the real MCP server as a started run (AMBIO_RUN_MESSAGE_ID) against a
 * real archd.
 */

let harness
let client

test.before(async () => {
  harness = await startHarness({ env: { AMBIO_RUN_MESSAGE_ID: 'turn-under-test' } })
  client = harness.client
}, { timeout: 90000 })

test.after(() => harness?.stop())

async function waiting() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${harness.apiBase}/api/agent/permission?workspace=${encodeURIComponent(harness.workspaceId)}`)
    const { requests } = await response.json()
    if (requests.length > 0) return requests
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail('the question never reached archd')
}
const decide = (id, decision) => fetch(`${harness.apiBase}/api/agent/permission/decide`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId: harness.workspaceId, id, decision }),
})

test('a started run is offered the permission tool beside the usual surface', async () => {
  const response = await client.request('tools/list', {})
  const names = response.result.tools.map(tool => tool.name)
  assert.ok(names.includes('approve_action'), names.join(', '))
  assert.ok(names.includes('get_inbox'))
})

test('the question waits for the user, lands on the turn, and the host gets its answer as JSON', async () => {
  const input = { command: 'npm install left-pad' }
  const asking = client.callTool('approve_action', { tool_name: 'Bash', input, tool_use_id: 'toolu_1' })
  const [request] = await waiting()
  assert.equal(request.messageId, 'turn-under-test')
  assert.equal(request.hostId, 'ambio-harness')
  assert.equal(request.title, 'Use Bash')
  assert.equal(request.detail, 'npm install left-pad')
  assert.equal((await decide(request.id, 'allow')).status, 200)
  const allowed = await asking
  assert.equal(allowed.isError, false, allowed.text)
  // Exactly the JSON the host parses: no notes, no trailer.
  assert.deepEqual(JSON.parse(allowed.text), { behavior: 'allow', updatedInput: input })

  const again = client.callTool('approve_action', { tool_name: 'Bash', input: { command: 'rm -rf build' } })
  const [second] = await waiting()
  assert.equal((await decide(second.id, 'deny')).status, 200)
  const refused = JSON.parse((await again).text)
  assert.equal(refused.behavior, 'deny')
  assert.match(refused.message, /did not allow/)
})
