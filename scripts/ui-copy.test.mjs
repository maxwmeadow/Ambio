import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Stored tool events use this separator on the wire. Their renderers split it
// or format it before showing the text.
const activityFormat = new Set([
  'electron/acpClient.ts',
  'electron/agentDrivers.ts',
  'electron/codexAppServer.ts',
  'electron/codexTranscript.ts',
  'src/renderer/components/AgentTurn.tsx',
  'src/renderer/components/agentActivity.ts',
  'src/renderer/screens/MapWithAgent.tsx',
])

test('Ambio copy avoids middle-dot separators', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const matches = []
  for (const folder of ['src', 'electron', 'archd-go/internal', 'mcp']) {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(?:tsx?|css|go)$/.test(entry.name)) continue
      const absolute = join(entry.parentPath, entry.name)
      const path = absolute.slice(root.length).replaceAll('\\', '/')
      if (activityFormat.has(path) || /(?:^|\/)(?:testdata|e2e)\/|(?:_test\.go|\.test\.tsx?)$/.test(path)) continue
      if (/[\u00b7]|\\(?:u00b7|0{0,4}b7)\b|&middot;|&#(?:183|x0*b7);/i.test(readFileSync(absolute, 'utf8'))) matches.push(path)
    }
  }
  assert.deepEqual(matches, [])
})
