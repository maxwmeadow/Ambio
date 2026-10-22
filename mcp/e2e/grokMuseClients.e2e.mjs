import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildHosts } from '../../electron/agentInstallers.ts'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'

// Drives the real server using each installer's persisted launcher. This proves
// the local MCP route, not a vendor CLI's model/authentication behavior.
for (const id of ['grok', 'muse']) {
  test(`${id} installed MCP can read architecture, draw and answer an addressed request`, { timeout: 90000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), `ambio-${id}-client-`))
    let harness
    try {
      harness = await startHarness({
        mcpLauncher: ({ command, args, projectDir }) => {
          const host = buildHosts(home).find(host => host.id === id)
          const result = host.install(command, args, '# Ambio mapping', projectDir)
          assert.ok(result.ok, result.detail)
          const source = readFileSync(host.configPath(), 'utf8')
          if (id === 'muse') {
            const server = JSON.parse(source).mcp_servers.ambio
            assert.equal(server.transport, 'stdio')
            return server
          }
          return {
            command: JSON.parse(source.match(/^command = (.+)$/m)[1]),
            args: JSON.parse(source.match(/^args = (.+)$/m)[1]),
          }
        },
      })
      const { client, workspaceId, apiBase } = harness
      const checked = await client.callTool('get_inbox', { verifyOnly: true, expectedWorkspaceId: workspaceId })
      assert.equal(checked.isError, false, checked.text)
      const architecture = await client.callTool('get_architecture', { scope: 'overview' })
      assert.equal(architecture.isError, false, architecture.text)
      const sheet = await client.callTool('edit_sheet', { op: 'create', name: `${id} proposal`, purpose: 'Verify the connected client can draw' })
      assert.equal(sheet.isError, false, sheet.text)
      const planned = await client.callTool('plan_element', { sheet: sheet.payload.created.id, name: 'Export service', kind: 'system', notes: 'Waiting for human review' })
      assert.equal(planned.isError, false, planned.text)
      assert.equal(planned.payload.approvalStatus, 'pending')
      const messageId = `${id}-request`
      const sent = await fetch(`${apiBase}/api/canvas/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: messageId, workspaceId, deliveryMode: 'addressed', note: 'Report the proposed architecture' }),
      })
      assert.ok(sent.ok, await sent.text())
      const claimed = await client.callTool('get_inbox', { messageId, expectedWorkspaceId: workspaceId })
      assert.equal(claimed.isError, false, claimed.text)
      assert.equal(claimed.payload.messages[0].id, messageId)
      const reply = await client.callTool('reply_to_canvas', { messageHandle: claimed.payload.messages[0].messageHandle, body: 'Proposal drawn for your review.' })
      assert.equal(reply.isError, false, reply.text)
      const presence = await fetch(`${apiBase}/api/agent/presence?workspace=${encodeURIComponent(workspaceId)}`)
      assert.ok((await presence.json()).connections.some(connection => connection.hostId === id && connection.lastToolAt > 0))
    } finally {
      harness?.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
