// Builds AmbioRewriter.dll, the C# instrumenter for `investigation run`
// (src/Rewriter, with the recorder source in src/Recorder embedded in it).
//
//   node adapters/dotnet/build.mjs
//
// Needs the .NET SDK 6 or newer (dotnet on PATH, or DOTNET_ROOT). The output is
// committed, so building Ambio itself never needs it; rerun this after
// changing the rewriter or the recorder. Nothing third-party ships: Roslyn
// comes from the user's own SDK when the rewriter runs.
import { execFileSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const dotnet = process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet') : 'dotnet'
const project = join(HERE, 'src', 'Rewriter')
const out = join(HERE, '.build')

rmSync(out, { recursive: true, force: true })
execFileSync(dotnet, ['build', join(project, 'AmbioRewriter.csproj'), '-c', 'Release', '-o', out, '--nologo', '-v', 'q'], {
  stdio: 'inherit',
  env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', AMBIO_EVIDENCE_DIR: '' },
})
for (const file of ['AmbioRewriter.dll', 'AmbioRewriter.runtimeconfig.json']) copyFileSync(join(out, file), join(HERE, file))
console.log(`Done - ${join(HERE, 'AmbioRewriter.dll')}`)
