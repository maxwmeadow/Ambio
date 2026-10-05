#!/usr/bin/env node
// Builds the runtime adapters archd injects into a user's program.
//
// The Node adapter is preloaded into someone else's process through
// NODE_OPTIONS, so it cannot rely on any node_modules: not the user's (their
// dependencies are theirs) and not Ambio's (inside app.asar, unreachable from a
// plain Node process). Its only third-party code - the parser and source
// rewriter in transform.cjs - is bundled in. The other files stay separate and
// verbatim because the bootstraps load each other by relative path.
//
// The Python adapter has no dependencies and is copied as-is.
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'adapters')
const OUT = join(ROOT, 'out', 'adapters')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'node'), { recursive: true })

for (const file of readdirSync(join(SRC, 'node'))) {
  if (file === 'transform.cjs') continue
  if (!/\.(cjs|mjs)$/.test(file)) continue
  cpSync(join(SRC, 'node', file), join(OUT, 'node', file))
}

const result = await build({
  entryPoints: [join(SRC, 'node', 'transform.cjs')],
  outfile: join(OUT, 'node', 'transform.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
})
if (result.errors.length > 0) process.exit(1)

cpSync(join(SRC, 'python'), join(OUT, 'python'), {
  recursive: true,
  filter: source => !/__pycache__|\.pyc$/.test(source),
})

console.log('Done - ' + OUT)
