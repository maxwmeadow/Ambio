// A stand-in MCP server for agentConnectionTest.test.mjs: newline-delimited
// JSON-RPC over stdio, in the mode named by its first argument.
import readline from 'node:readline'

const mode = process.argv[2]
if (mode === 'crash') {
  console.error('boom')
  process.exit(3)
}
if (process.env.AMBIO_SELF_TEST !== '1') {
  console.error('probe did not mark itself as a self test')
  process.exit(4)
}
const reply = message => process.stdout.write(JSON.stringify(message) + '\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (mode === 'silent') return
  const message = JSON.parse(line)
  if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
  if (message.method === 'tools/list') {
    reply({ jsonrpc: '2.0', id: message.id, result: { tools: mode === 'empty' ? [] : [{ name: 'a' }, { name: 'b' }] } })
  }
})
