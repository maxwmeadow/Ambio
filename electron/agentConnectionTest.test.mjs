import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configNamesServer, configurationChecks, probeMcpServer } from './agentConnectionTest.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

test('a configuration names this install however its path is written', () => {
  const server = 'C:\\Program Files\\Ambio\\resources\\mcp\\ambio-mcp.js'
  assert.equal(configNamesServer(JSON.stringify({ mcpServers: { ambio: { args: [server] } } }), server), true)
  assert.equal(configNamesServer('args = ["C:/Program Files/Ambio/resources/mcp/ambio-mcp.js"]', server), true)
  assert.equal(configNamesServer('args = ["c:\\program files\\ambio\\resources\\mcp\\ambio-mcp.js"]', server), true)
  assert.equal(configNamesServer(JSON.stringify({ mcpServers: { ambio: { args: ['D:\\old\\ambio-mcp.js'] } } }), server), false)
})

test('configuration checks say what is wrong and what fixes it', () => {
  const server = path.resolve('mcp', 'ambio-mcp.js')
  const base = { configuredPaths: [], unreadablePaths: [], workflowInstalled: false, workflowPath: null }

  const missing = configurationChecks('Cursor', { ...base, configured: false }, server)
  assert.deepEqual(missing.map(check => [check.id, check.state]), [['configured', 'fail']])
  assert.match(missing[0].detail, /Install it first/)

  const unreadable = configurationChecks('Cursor', { ...base, configured: false, unreadablePaths: ['mcp.json'] }, server)
  assert.match(unreadable[0].detail, /Could not read mcp\.json/)

  const current = configurationChecks('Cursor', { ...base, configured: true, configuredPaths: ['mcp.json'], workflowInstalled: true }, server,
    () => JSON.stringify({ args: [server] }))
  assert.deepEqual(current.map(check => [check.id, check.state]), [['configured', 'pass'], ['current', 'pass'], ['workflow', 'pass']])

  const stale = configurationChecks('Cursor', { ...base, configured: true, configuredPaths: ['mcp.json'] }, server,
    () => JSON.stringify({ args: ['/somewhere/else/ambio-mcp.js'] }))
  assert.deepEqual(stale.map(check => [check.id, check.state]), [['configured', 'pass'], ['current', 'fail'], ['workflow', 'fail']])
  assert.match(stale[1].detail, /Repair rewrites it/)
})

test('the probe reports a server that lists tools, one that does not start, and one that never answers', { timeout: 30000 }, async () => {
  const fake = path.join(here, 'testdata', 'fakeMcpServer.mjs')
  const working = await probeMcpServer(process.execPath, [fake, 'ok'], 10000)
  assert.deepEqual([working.ok, working.tools], [true, 2])

  const empty = await probeMcpServer(process.execPath, [fake, 'empty'], 10000)
  assert.equal(empty.ok, false)
  assert.match(empty.detail, /listed no tools/)

  const crashed = await probeMcpServer(process.execPath, [fake, 'crash'], 10000)
  assert.equal(crashed.ok, false)
  assert.match(crashed.detail, /stopped before answering.*boom/)

  const silent = await probeMcpServer(process.execPath, [fake, 'silent'], 500)
  assert.equal(silent.ok, false)
  assert.match(silent.detail, /did not answer/)

  const absent = await probeMcpServer(path.join(here, 'no-such-binary'), [], 5000)
  assert.equal(absent.ok, false)
})
