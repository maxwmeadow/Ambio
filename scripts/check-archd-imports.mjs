#!/usr/bin/env node
// Fails when archd.exe imports a DLL that a clean Windows install does not
// have. archd is CGO; built with MSYS2's MinGW it can silently depend on
// libgcc_s_seh-1.dll / libwinpthread-1.dll / libstdc++-6.dll, which works on a
// developer's machine and nowhere else. The installer promises one download
// and nothing else to set up.
//
// Usage: node scripts/check-archd-imports.mjs [path/to/archd.exe]
// Needs objdump on PATH (mingw64/bin on the CI runner).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const exe = process.argv[2] ?? path.join('archd-go', 'archd.exe')
if (process.platform !== 'win32') {
  console.log('check-archd-imports: Windows only, skipping')
  process.exit(0)
}
if (!existsSync(exe)) {
  console.error(`check-archd-imports: ${exe} not found - build archd first`)
  process.exit(1)
}

// DLLs every supported Windows (10 and 11) ships in System32.
const SYSTEM = new Set([
  'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'advapi32.dll', 'shell32.dll', 'ole32.dll',
  'oleaut32.dll', 'ws2_32.dll', 'mswsock.dll', 'winmm.dll', 'bcrypt.dll', 'crypt32.dll', 'secur32.dll',
  'userenv.dll', 'dbghelp.dll', 'iphlpapi.dll', 'powrprof.dll', 'shlwapi.dll', 'version.dll', 'msvcrt.dll',
  'ucrtbase.dll', 'netapi32.dll', 'psapi.dll', 'gdi32.dll', 'comctl32.dll', 'setupapi.dll', 'rpcrt4.dll',
])

const dump = execFileSync('objdump', ['-p', exe], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const imports = [...dump.matchAll(/DLL Name:\s*(\S+)/g)].map(m => m[1])
const foreign = imports.filter(name => {
  const lower = name.toLowerCase()
  return !SYSTEM.has(lower) && !lower.startsWith('api-ms-win-') && !lower.startsWith('ext-ms-win-')
})
console.log(`archd.exe imports: ${imports.join(', ')}`)
if (foreign.length > 0) {
  console.error(`check-archd-imports: archd.exe needs DLLs a clean Windows lacks: ${foreign.join(', ')}`)
  console.error('Link statically (scripts/archd.sh sets -extldflags=-static on Windows).')
  process.exit(1)
}
console.log('check-archd-imports: only system DLLs')
