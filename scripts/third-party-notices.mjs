#!/usr/bin/env node
// Third-party notices and license policy.
//
// Ambio is AGPL-3.0. Everything it ships - the npm packages in the app and
// MCP bundles, and the Go modules linked into archd - must be under a license
// the AGPL can include, and most of those licenses require their notice to
// travel with the software. This script checks the first and produces the
// second: out/licenses/THIRD_PARTY_NOTICES.txt, shipped with every build and
// shown in Help → Acknowledgements.
//
//   node scripts/third-party-notices.mjs          write notices, fail on a bad license
//   node scripts/third-party-notices.mjs --check  only check
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = path.join(ROOT, 'out', 'licenses', 'THIRD_PARTY_NOTICES.txt')
const CHECK_ONLY = process.argv.includes('--check')

// Licenses that may be combined into an AGPL-3.0 program. Anything else needs
// a human decision, so the build stops and says which package.
export const COMPATIBLE = new Set([
  'MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'BlueOak-1.0.0',
  'CC0-1.0', 'Unlicense', 'Python-2.0', 'MPL-2.0', 'Zlib', 'CC-BY-4.0', 'WTFPL',
  'LGPL-2.1-or-later', 'LGPL-3.0-or-later', 'GPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  // Fonts: the OFL allows bundling fonts with any software; they stay under
  // their own license as a separate work (the interface fonts).
  'OFL-1.1',
])

/** True when an SPDX expression allows use under at least one compatible license. */
export function licenseAllowed(expression) {
  if (!expression) return false
  const cleaned = expression.replace(/[()]/g, ' ').trim()
  // "A OR B": any one suffices. "A AND B": every part must be compatible.
  return cleaned.split(/\s+OR\s+/).some(alternative =>
    alternative.split(/\s+AND\s+/).every(part => COMPATIBLE.has(part.trim())))
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i

function licenseTexts(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter(name => LICENSE_FILE.test(name))
    .sort()
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8').trim())
}

function npmPackages() {
  const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  }))
  const found = new Map()
  const walk = node => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const key = `${name}@${child.version}`
      if (found.has(key)) continue
      const dir = path.join(ROOT, 'node_modules', name)
      let manifest = null
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { /* optional, not installed here */ }
      if (manifest && manifest.version === child.version) {
        let license = typeof manifest.license === 'string'
          ? manifest.license
          : manifest.license?.type ?? manifest.licenses?.map(entry => entry.type ?? entry).join(' OR ')
        let texts = licenseTexts(dir)
        // The pinned native packages omit SPDX metadata. Use the license from
        // the matching upstream release, never a blanket unknown-license pass.
        if (/^opencode-(linux|darwin|windows)-(x64|arm64)(-baseline)?$/.test(name) && child.version === '1.18.34') {
          license = 'MIT'
          texts = [fs.readFileSync(path.join(ROOT, 'scripts', 'licenses', 'opencode-1.18.34.txt'), 'utf8').trim()]
        }
        found.set(key, { name, version: child.version, license, texts, source: 'npm' })
      }
      walk(child)
    }
  }
  walk(tree)
  return [...found.values()]
}

// Go module licenses are not declared in go.mod, so the text is read and the
// family recognised from it.
function spdxFromText(text) {
  if (/Apache License\s+Version 2\.0/i.test(text)) return 'Apache-2.0'
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT'
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  }
  if (/Mozilla Public License,? v(ersion)?\.? ?2\.0/i.test(text)) return 'MPL-2.0'
  return null
}

function goModules() {
  const lines = execFileSync('go', ['list', '-deps', '-f', '{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}', './cmd/archd'], {
    cwd: path.join(ROOT, 'archd-go'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\n')
  const found = new Map()
  for (const line of lines) {
    const [modulePath, version, dir] = line.trim().split('|')
    if (!modulePath || modulePath.startsWith('ambio.local') || found.has(modulePath)) continue
    const texts = licenseTexts(dir)
    found.set(modulePath, {
      name: modulePath, version, texts, source: 'go',
      license: texts.map(spdxFromText).find(Boolean) ?? null,
    })
  }
  return [...found.values()]
}

function main() {
  const packages = [...npmPackages(), ...goModules()].sort((left, right) => left.name.localeCompare(right.name))
  const blocked = packages.filter(entry => !licenseAllowed(entry.license))
  if (blocked.length > 0) {
    console.error('Third-party licenses that are not known to be AGPL-3.0 compatible:')
    for (const entry of blocked) console.error(`  ${entry.source} ${entry.name}@${entry.version}: ${entry.license ?? 'unknown'}`)
    console.error('Remove the dependency, or confirm the license and add it to COMPATIBLE in scripts/third-party-notices.mjs.')
    process.exit(1)
  }
  console.log(`Licenses OK: ${packages.length} third-party components.`)
  if (CHECK_ONLY) return

  const sections = packages.map(entry => [
    '-'.repeat(78),
    `${entry.name} ${entry.version}  (${entry.license})`,
    '',
    entry.texts.length > 0 ? entry.texts.join('\n\n') : `Licensed under ${entry.license}. No license file was included in the distributed package.`,
  ].join('\n'))
  const header = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Ambio is free software under the GNU Affero General Public License v3.0.',
    'It includes the third-party components listed below, each under its own license.',
    'Electron and Chromium notices ship alongside the application as',
    'LICENSE.electron.txt and LICENSES.chromium.html.',
    '',
  ].join('\n')
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, `${header}\n${sections.join('\n\n')}\n`)
  console.log(`Wrote ${path.relative(ROOT, OUT)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
