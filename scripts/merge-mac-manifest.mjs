#!/usr/bin/env node
// Merges the latest-mac.yml files written by the arm64 and x64 release jobs
// into one, so electron-updater on either architecture finds its own build.
// Each job publishes its own manifest and the last upload wins; the release
// workflow runs this afterwards and replaces it (.github/workflows/release.yml).
//
//   node scripts/merge-mac-manifest.mjs arm64/latest-mac.yml x64/latest-mac.yml > latest-mac.yml
//
// The manifest shape is fixed by electron-builder, so it is read and written
// here directly rather than through a YAML dependency.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Parse electron-builder's latest-mac.yml. */
export function parseManifest(text) {
  const manifest = { files: [] }
  let current = null
  let inFiles = false
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const item = raw.match(/^\s+-\s+(\w+):\s*(.*)$/)
    const nested = raw.match(/^\s{2,}(\w+):\s*(.*)$/)
    const top = raw.match(/^(\w+):\s*(.*)$/)
    if (item && inFiles) {
      current = { [item[1]]: scalar(item[2]) }
      manifest.files.push(current)
    } else if (nested && inFiles && current) {
      current[nested[1]] = scalar(nested[2])
    } else if (top) {
      inFiles = top[1] === 'files'
      current = null
      if (!inFiles) manifest[top[1]] = scalar(top[2])
    }
  }
  return manifest
}

function scalar(value) {
  const trimmed = value.trim()
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'")
  if (/^".*"$/.test(trimmed)) return JSON.parse(trimmed)
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function quote(value) {
  if (typeof value === 'number') return String(value)
  return /^[\w.\-/+=]+$/.test(value) && !/^\d+$/.test(value) ? value : `'${String(value).replace(/'/g, "''")}'`
}

/** Write a manifest in electron-builder's layout. */
export function formatManifest(manifest) {
  const lines = [`version: ${quote(manifest.version)}`, 'files:']
  for (const file of manifest.files) {
    const [first, ...rest] = Object.entries(file)
    lines.push(`  - ${first[0]}: ${quote(first[1])}`)
    for (const [key, value] of rest) lines.push(`    ${key}: ${quote(value)}`)
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'version' || key === 'files') continue
    lines.push(`${key}: ${quote(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * One manifest listing both architectures' files. The top-level path stays
 * the x64 build's, which is what an updater that cannot tell picks; Apple
 * Silicon updaters choose the arm64 file from the list by name.
 */
export function mergeManifests(arm64, x64) {
  if (arm64.version !== x64.version) {
    throw new Error(`version mismatch: arm64 ${arm64.version}, x64 ${x64.version}`)
  }
  const seen = new Set()
  const files = [...x64.files, ...arm64.files].filter(file => {
    if (seen.has(file.url)) return false
    seen.add(file.url)
    return true
  })
  const releaseDate = [arm64.releaseDate, x64.releaseDate].filter(Boolean).sort().at(-1)
  return { ...x64, files, ...(releaseDate ? { releaseDate } : {}) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [arm64Path, x64Path] = process.argv.slice(2)
  if (!arm64Path || !x64Path) {
    console.error('usage: merge-mac-manifest.mjs <arm64 latest-mac.yml> <x64 latest-mac.yml>')
    process.exit(2)
  }
  const merged = mergeManifests(
    parseManifest(readFileSync(arm64Path, 'utf8')),
    parseManifest(readFileSync(x64Path, 'utf8')),
  )
  process.stdout.write(formatManifest(merged))
}
