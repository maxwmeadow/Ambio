import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
const server = new McpServer({ name: 'ambio-chat-test', version: '1.0.0' })
server.tool('get_architecture', 'Read the project architecture', {}, async () => ({ content: [{ type: 'text', text: 'Architecture fixture: UI depends on Storage.' }] }))
server.tool('edit_sheet', 'Change architecture', {}, async () => ({ content: [{ type: 'text', text: 'Sheet updated.' }] }))
await server.connect(new StdioServerTransport())
