#!/usr/bin/env node
// Builds the runtime adapters archd injects into a user's program.
//
// The Node adapter is preloaded into someone else's process through
// NODE_OPTIONS, so it cannot rely on any node_modules: not the user's (their
// dependencies are theirs) and not Axiom's (inside app.asar, unreachable from a
// plain Node process). Its only third-party code - the parser and source
// rewriter in transform.cjs - is bundled in. The other files stay separate and
// verbatim because the bootstraps load each other by relative path.
//
// The Python and Ruby adapters have no dependencies and are copied as-is; the
// JVM agent is a jar built ahead of time.
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
  filter: source => !/__pycache__|\.pyc$|\.test\.mjs$/.test(source),
})

// The Ruby recorder is plain Ruby, loaded by the user's own interpreter.
cpSync(join(SRC, 'ruby'), join(OUT, 'ruby'), { recursive: true, filter: source => !/\.test\.mjs$/.test(source) })

// The PHP recorder is plain PHP, loaded by the user's own interpreter.
cpSync(join(SRC, 'php'), join(OUT, 'php'), { recursive: true, filter: source => !/\.test\.mjs$/.test(source) })

// The JVM recorder is a prebuilt agent jar (adapters/java/build.mjs rebuilds
// it; that needs a JDK, building Axiom does not). ASM ships inside it under
// its BSD license.
mkdirSync(join(OUT, 'java'), { recursive: true })
for (const file of ['axiom-agent.jar', 'ASM-LICENSE.txt']) cpSync(join(SRC, 'java', file), join(OUT, 'java', file))

// The C# recorder is an MSBuild targets file and the prebuilt rewriter it runs
// (adapters/dotnet/build.mjs rebuilds it; that needs the .NET SDK, building
// Axiom does not). It ships nothing third-party: Roslyn comes from the user's
// own SDK.
mkdirSync(join(OUT, 'dotnet'), { recursive: true })
for (const file of ['Axiom.targets', 'AxiomRewriter.dll', 'AxiomRewriter.runtimeconfig.json']) {
  cpSync(join(SRC, 'dotnet', file), join(OUT, 'dotnet', file))
}

console.log('Done - ' + OUT)
