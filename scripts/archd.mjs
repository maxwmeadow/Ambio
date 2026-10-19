#!/usr/bin/env node
// Cross-platform entry point for the archd Go toolchain scripts.
//
// scripts/archd.sh does the real work. What is not portable is choosing the
// shell that runs it: Windows needs MSYS2's bash specifically, because the Go
// and GCC toolchains archd builds against live inside that environment and
// TDM-GCC is not a substitute. macOS and Linux just need the system bash.
//
// Keeping that choice here means package.json stays free of absolute paths,
// so the same `npm run` commands work on every platform.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'

  const candidates = [process.env.AMBIO_MSYS2_BASH, 'C:\\msys64\\usr\\bin\\bash.exe'].filter(Boolean)
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    console.error(
      'archd: MSYS2 bash not found.\n' +
      'Install MSYS2 to C:\\msys64, or point AMBIO_MSYS2_BASH at its usr/bin/bash.exe.'
    )
    process.exit(1)
  }
  return found
}

// MSYS2 bash needs its own usr/bin (uname, etc.) on PATH. Invoked from a
// plain PowerShell/cmd process, the inherited PATH is pure Windows-style and
// has no MSYS2 entries at all, so bare bash.exe cannot find the core utilities
// scripts/archd.sh calls to detect the platform.
const bash = resolveBash()
const env = { ...process.env }
// Stamped into the daemon so the app can tell whether a running archd is its own.
env.AMBIO_VERSION ??= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (process.platform === 'win32') {
  const msysRoot = bash.replace(/[\\/]usr[\\/]bin[\\/]bash\.exe$/i, '')
  // Windows spells it "Path". process.env lookups are case-insensitive there,
  // but a plain spread is not - assigning env.PATH would leave the real "Path"
  // untouched and hand the child two variables, with the original winning. The
  // Go that setup-go puts on Path would then be invisible to archd.sh.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${msysRoot}\\usr\\bin;${env[pathKey] ?? ''}`
}

// Linking archd against SQLite through cgo takes most of half a minute on
// Windows even when nothing changed, and `npm run dev` builds it every time.
// A binary newer than every Go source, go.mod/go.sum and package.json (its
// version is stamped in) is current. AMBIO_FORCE_ARCHD_BUILD=1 builds anyway.
function newestSource(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'testdata' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(path))
    else if (/\.(go|c|h)$|^go\.(mod|sum)$/.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}
if ((process.argv[2] ?? 'build') === 'build' && process.env.AMBIO_FORCE_ARCHD_BUILD !== '1') {
  const binary = join(ROOT, 'archd-go', process.platform === 'win32' ? 'archd.exe' : 'archd')
  const built = existsSync(binary) ? statSync(binary).mtimeMs : 0
  const sources = Math.max(newestSource(join(ROOT, 'archd-go')), statSync(join(ROOT, 'package.json')).mtimeMs)
  if (built > sources) {
    console.log(`archd is up to date - ${binary}`)
    process.exit(0)
  }
}

// Invoked relative to the repo root so the path stays valid inside MSYS2,
// which does not understand a Windows-style absolute path here.
const { status } = spawnSync(bash, ['scripts/archd.sh', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
})
process.exit(status ?? 1)
