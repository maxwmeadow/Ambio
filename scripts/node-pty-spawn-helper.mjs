// node-pty 1.1.0 publishes its macOS spawn-helper without the execute bit, so
// every terminal on macOS fails with "posix_spawnp failed" (microsoft/node-pty
// prebuilds). Restore it after install; electron-builder then packs the
// executable helper into app.asar.unpacked as it found it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const prebuilds = fileURLToPath(new URL('../node_modules/node-pty/prebuilds', import.meta.url))
let entries = []
try { entries = fs.readdirSync(prebuilds) } catch { process.exit(0) }
for (const entry of entries) {
  const helper = path.join(prebuilds, entry, 'spawn-helper')
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}
